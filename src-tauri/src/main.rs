#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{Connection, OptionalExtension, Transaction};
use std::{
    collections::HashMap,
    env,
    error::Error,
    fs::{create_dir_all, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const COLLECTIONS: [&str; 5] = ["degrees", "semesters", "subjects", "syllabus", "notes"];
const MAX_IPC_CHUNK_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 150 * 1024 * 1024;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

struct ApiProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    request_id: u64,
}

struct Transfer {
    content: String,
    created: Instant,
}

struct ApiRuntime(Arc<Mutex<ApiState>>);

struct ApiState {
    process: Option<ApiProcess>,
    database: Option<Connection>,
    database_path: Option<PathBuf>,
    runtime_directory: Option<PathBuf>,
    node_executable: Option<PathBuf>,
    log_path: Option<PathBuf>,
    request_id: u64,
    request_chunks: HashMap<String, Transfer>,
    response_chunks: HashMap<String, Transfer>,
}

fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let project_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Unable to locate the project directory.".to_string())?
            .to_path_buf();
        let node_executable = project_directory
            .join("src-tauri")
            .join("runtime")
            .join("node.exe");
        Ok((project_directory, node_executable))
    }

    #[cfg(not(debug_assertions))]
    {
        let runtime_directory = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("runtime");
        let node_executable = runtime_directory.join("node.exe");
        Ok((runtime_directory, node_executable))
    }
}

fn database_path() -> Result<PathBuf, String> {
    let data_directory = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local").join("share"))
        })
        .ok_or_else(|| "The local application data directory is unavailable.".to_string())?;
    Ok(data_directory
        .join("DegreeStudyManager")
        .join("degree-study-manager.sqlite"))
}

fn runtime_log_path() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("DegreeStudyManager")
        .join("desktop-runtime.log")
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(directory) = path.parent() {
        create_dir_all(directory)
            .map_err(|error| format!("Unable to create the local database directory: {error}"))?;
    }
    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open the local SQLite database: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Unable to configure the local SQLite database: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Unable to configure the local SQLite database: {error}"))?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (collection, id)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS record_summaries (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL,
                PRIMARY KEY (collection, id)
            ) WITHOUT ROWID;",
        )
        .map_err(|error| format!("Unable to initialize the local SQLite database: {error}"))
}

fn ensure_database(state: &mut ApiState) -> Result<&mut Connection, String> {
    if state.database.is_none() {
        let path = state
            .database_path
            .as_ref()
            .ok_or_else(|| "The local application data directory is unavailable.".to_string())?;
        state.database = Some(open_database(path)?);
    }
    state
        .database
        .as_mut()
        .ok_or_else(|| "The local SQLite database is unavailable.".to_string())
}

fn validate_collection_records<'a>(
    data: &'a serde_json::Value,
    collection: &str,
) -> Result<&'a Vec<serde_json::Value>, String> {
    let records = data
        .get(collection)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("The {collection} database collection is invalid."))?;
    if records.iter().any(|record| {
        record
            .get("id")
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
    }) {
        return Err(format!("A record in {collection} has an invalid id."));
    }
    Ok(records)
}

fn validate_database(data: &serde_json::Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("The database backup has an invalid format.".to_string());
    }
    for collection in COLLECTIONS {
        validate_collection_records(data, collection)?;
    }
    Ok(())
}

fn read_database(connection: &Connection) -> Result<serde_json::Value, String> {
    let mut database: serde_json::Map<String, serde_json::Value> = COLLECTIONS
        .iter()
        .map(|collection| (collection.to_string(), serde_json::json!([])))
        .collect();
    let mut statement = connection
        .prepare("SELECT collection, payload FROM records ORDER BY collection, id")
        .map_err(|error| format!("Unable to read the local SQLite database: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query the local SQLite database: {error}"))?;
    for row in rows {
        let (collection, payload) =
            row.map_err(|error| format!("Unable to read a local database record: {error}"))?;
        if !COLLECTIONS.contains(&collection.as_str()) {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|error| format!("A saved {collection} record is invalid: {error}"))?;
        database
            .get_mut(&collection)
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| format!("The {collection} database collection is unavailable."))?
            .push(record);
    }
    Ok(serde_json::Value::Object(database))
}

fn summarize_record(collection: &str, record: &serde_json::Value) -> Result<String, String> {
    if collection != "notes" {
        return serde_json::to_string(record)
            .map_err(|error| format!("Unable to encode a {collection} record summary: {error}"));
    }

    let fields = record
        .as_object()
        .ok_or_else(|| "A saved notes record is invalid.".to_string())?;
    let summary = fields
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "dataUrl" | "text" | "cells"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    serde_json::to_string(&serde_json::Value::Object(summary))
        .map_err(|error| format!("Unable to encode a notes record summary: {error}"))
}

fn ensure_record_summaries(connection: &Connection) -> Result<(), String> {
    let has_missing_summary: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM records AS r
                LEFT JOIN record_summaries AS s
                    ON s.collection = r.collection AND s.id = r.id
                WHERE s.id IS NULL
                LIMIT 1
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to check the local record index: {error}"))?;

    if has_missing_summary {
        connection
            .execute(
                "INSERT OR IGNORE INTO record_summaries (collection, id, payload, payload_bytes)
                 SELECT collection, id,
                    CASE
                        WHEN collection = 'notes'
                        THEN json_remove(payload, '$.dataUrl', '$.text', '$.cells')
                        ELSE payload
                        END,
                        length(CAST(payload AS BLOB))
                     FROM records",
                [],
            )
            .map_err(|error| format!("Unable to optimize the local database index: {error}"))?;
    }
    Ok(())
}

fn read_database_index(connection: &Connection) -> Result<serde_json::Value, String> {
    ensure_record_summaries(connection)?;
    let mut database: serde_json::Map<String, serde_json::Value> = COLLECTIONS
        .iter()
        .map(|collection| (collection.to_string(), serde_json::json!([])))
        .collect();
    let mut record_bytes: serde_json::Map<String, serde_json::Value> = COLLECTIONS
        .iter()
        .map(|collection| (collection.to_string(), serde_json::json!({})))
        .collect();
    let mut statement = connection
        .prepare(
            "SELECT collection, id, payload, payload_bytes
             FROM record_summaries ORDER BY collection, id",
        )
        .map_err(|error| format!("Unable to read the local record index: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| format!("Unable to query the local record index: {error}"))?;
    for row in rows {
        let (collection, id, payload, payload_bytes) =
            row.map_err(|error| format!("Unable to read a local record summary: {error}"))?;
        if !COLLECTIONS.contains(&collection.as_str()) {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|error| format!("A saved {collection} record summary is invalid: {error}"))?;
        database
            .get_mut(&collection)
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| format!("The {collection} database collection is unavailable."))?
            .push(record);
        record_bytes
            .get_mut(&collection)
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| format!("The {collection} database collection is unavailable."))?
            .insert(id, serde_json::json!(payload_bytes));
    }
    Ok(serde_json::json!({
        "database": database,
        "recordBytes": record_bytes
    }))
}

fn read_database_record(
    connection: &Connection,
    collection: &str,
    id: &str,
) -> Result<serde_json::Value, String> {
    if !COLLECTIONS.contains(&collection) || id.is_empty() {
        return Err("The requested local database record is invalid.".to_string());
    }
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM records WHERE collection = ?1 AND id = ?2",
            (collection, id),
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read the local {collection} record: {error}"))?;
    let payload =
        payload.ok_or_else(|| format!("The requested {collection} record was not found."))?;
    serde_json::from_str(&payload)
        .map_err(|error| format!("A saved {collection} record is invalid: {error}"))
}

fn store_records(
    transaction: &Transaction<'_>,
    collection: &str,
    records: &[serde_json::Value],
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "INSERT INTO records (collection, id, payload) VALUES (?1, ?2, ?3)
             ON CONFLICT(collection, id) DO UPDATE SET payload = excluded.payload",
        )
        .map_err(|error| format!("Unable to prepare a local database save: {error}"))?;
    let mut summary_statement = transaction
        .prepare(
            "INSERT INTO record_summaries (collection, id, payload, payload_bytes)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(collection, id) DO UPDATE SET
                payload = excluded.payload,
                payload_bytes = excluded.payload_bytes",
        )
        .map_err(|error| format!("Unable to prepare a local record index save: {error}"))?;
    for record in records {
        let id = record["id"]
            .as_str()
            .ok_or_else(|| format!("A record in {collection} has an invalid id."))?;
        let payload = serde_json::to_string(record)
            .map_err(|error| format!("Unable to encode a {collection} record: {error}"))?;
        let summary = summarize_record(collection, record)?;
        let payload_bytes = payload.len() as i64;
        statement
            .execute((collection, id, &payload))
            .map_err(|error| format!("Unable to save a {collection} record: {error}"))?;
        summary_statement
            .execute((collection, id, summary, payload_bytes))
            .map_err(|error| format!("Unable to save a {collection} record summary: {error}"))?;
    }
    Ok(())
}

fn replace_database(connection: &mut Connection, data: &serde_json::Value) -> Result<(), String> {
    validate_database(data)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Unable to begin a local database update: {error}"))?;
    transaction
        .execute("DELETE FROM records", [])
        .map_err(|error| format!("Unable to replace the local database: {error}"))?;
    transaction
        .execute("DELETE FROM record_summaries", [])
        .map_err(|error| format!("Unable to replace the local record index: {error}"))?;
    for collection in COLLECTIONS {
        store_records(
            &transaction,
            collection,
            validate_collection_records(data, collection)?,
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit the local database update: {error}"))
}

fn apply_database_changes(
    connection: &mut Connection,
    changes: &serde_json::Value,
) -> Result<(), String> {
    let upsert = changes
        .get("upsert")
        .ok_or_else(|| "Database changes have an invalid format.".to_string())?;
    let delete = changes
        .get("delete")
        .ok_or_else(|| "Database changes have an invalid format.".to_string())?;
    for collection in COLLECTIONS {
        validate_collection_records(upsert, collection)?;
        if delete
            .get(collection)
            .and_then(serde_json::Value::as_array)
            .is_none_or(|ids| ids.iter().any(|id| id.as_str().is_none_or(str::is_empty)))
        {
            return Err(format!("The {collection} delete list is invalid."));
        }
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Unable to begin a local database update: {error}"))?;
    for collection in COLLECTIONS {
        let mut statement = transaction
            .prepare("DELETE FROM records WHERE collection = ?1 AND id = ?2")
            .map_err(|error| {
                format!("Unable to prepare a {collection} record deletion: {error}")
            })?;
        let mut summary_statement = transaction
            .prepare("DELETE FROM record_summaries WHERE collection = ?1 AND id = ?2")
            .map_err(|error| {
                format!("Unable to prepare a {collection} summary deletion: {error}")
            })?;
        for id in delete[collection].as_array().into_iter().flatten() {
            let id = id.as_str().unwrap_or_default();
            statement
                .execute((collection, id))
                .map_err(|error| format!("Unable to delete a {collection} record: {error}"))?;
            summary_statement
                .execute((collection, id))
                .map_err(|error| {
                    format!("Unable to delete a {collection} record summary: {error}")
                })?;
        }
        drop(statement);
        drop(summary_statement);
        store_records(
            &transaction,
            collection,
            upsert[collection].as_array().unwrap(),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit the local database update: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::remove_file, time::SystemTime};

    #[test]
    fn external_pdf_links_only_allow_safe_http_and_https_addresses() {
        assert!(validate_external_url("https://example.com/path?q=term").is_ok());
        assert!(validate_external_url("http://example.com").is_ok());
        for invalid in [
            "javascript:alert(1)",
            "file:///C:/Users/example.txt",
            "https://",
            "https://user@example.com",
            "https://example.com/path with spaces",
        ] {
            assert!(
                validate_external_url(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    fn test_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("initialize test database");
        connection
    }

    fn empty_database() -> serde_json::Value {
        serde_json::json!({
            "degrees":[],
            "semesters":[],
            "subjects":[],
            "syllabus":[],
            "notes":[]
        })
    }

    #[test]
    fn native_sqlite_round_trips_records_and_applies_incremental_changes() {
        let mut connection = test_database();
        let mut data = empty_database();
        data["degrees"] = serde_json::json!([{"id":"degree-1","name":"Local degree"}]);
        replace_database(&mut connection, &data).expect("replace database");
        assert_eq!(read_database(&connection).expect("read database"), data);

        let changes = serde_json::json!({
            "upsert":{"degrees":[{"id":"degree-2","name":"Second degree"}],"semesters":[],"subjects":[],"syllabus":[],"notes":[]},
            "delete":{"degrees":["degree-1"],"semesters":[],"subjects":[],"syllabus":[],"notes":[]}
        });
        apply_database_changes(&mut connection, &changes).expect("apply changes");
        assert_eq!(
            read_database(&connection).expect("read updated database")["degrees"],
            serde_json::json!([{"id":"degree-2","name":"Second degree"}])
        );
    }

    #[test]
    fn invalid_database_replacement_does_not_delete_saved_records() {
        let mut connection = test_database();
        let mut original = empty_database();
        original["degrees"] = serde_json::json!([{"id":"degree-1","name":"Keep me"}]);
        replace_database(&mut connection, &original).expect("seed database");

        let mut invalid = empty_database();
        invalid["degrees"] = serde_json::json!([{"name":"Missing id"}]);
        assert!(replace_database(&mut connection, &invalid).is_err());
        assert_eq!(
            read_database(&connection).expect("read unchanged database"),
            original
        );
    }

    #[test]
    fn existing_database_index_is_built_once_and_large_note_content_is_loaded_on_demand() {
        let connection = test_database();
        let legacy_payload = r#"{"id":"note-1","title":"Photo","type":"image","dataUrl":"data:image/png;base64,huge","size":5242880}"#;
        connection
            .execute(
                "INSERT INTO records (collection, id, payload) VALUES (?1, ?2, ?3)",
                ("notes", "note-1", legacy_payload),
            )
            .expect("seed legacy note");

        let index = read_database_index(&connection).expect("build record index");
        let note_summary = &index["database"]["notes"][0];
        assert_eq!(note_summary["title"], "Photo");
        assert_eq!(note_summary["size"], 5242880);
        assert!(note_summary.get("dataUrl").is_none());
        assert_eq!(
            index["recordBytes"]["notes"]["note-1"],
            legacy_payload.len()
        );
        assert_eq!(
            read_database_record(&connection, "notes", "note-1").expect("read full note")
                ["dataUrl"],
            "data:image/png;base64,huge"
        );

        let changes = serde_json::json!({
            "upsert":{"degrees":[],"semesters":[],"subjects":[],"syllabus":[],"notes":[{"id":"note-1","title":"Updated","type":"image","dataUrl":"data:image/png;base64,new","size":5}]},
            "delete":{"degrees":[],"semesters":[],"subjects":[],"syllabus":[],"notes":[]}
        });
        let mut connection = connection;
        apply_database_changes(&mut connection, &changes).expect("update indexed note");
        let updated_index = read_database_index(&connection).expect("read updated record index");
        assert_eq!(updated_index["database"]["notes"][0]["title"], "Updated");
        assert!(updated_index["database"]["notes"][0]
            .get("dataUrl")
            .is_none());
    }

    #[test]
    fn database_pages_preserve_record_order_and_advance_without_starting_a_worker() {
        let mut connection = test_database();
        let mut data = empty_database();
        data["degrees"] = serde_json::json!([
            {"id":"degree-a","name":"First"},
            {"id":"degree-b","name":"Second"},
            {"id":"degree-c","name":"Third"}
        ]);
        replace_database(&mut connection, &data).expect("seed paginated database");

        let first =
            read_database_page(&connection, "degrees", 0, 1).expect("read first database page");
        assert_eq!(first["records"].as_array().unwrap().len(), 1);
        assert_eq!(first["nextOffset"], 1);
        assert_eq!(first["total"], 3);
        assert_eq!(first["complete"], false);

        let rest = read_database_page(&connection, "degrees", 1, 16 * 1024 * 1024)
            .expect("read final database page");
        assert_eq!(rest["nextOffset"], 3);
        assert_eq!(rest["complete"], true);
        let mut combined = first["records"].as_array().unwrap().clone();
        combined.extend(rest["records"].as_array().unwrap().iter().cloned());
        assert_eq!(combined, data["degrees"].as_array().unwrap().clone());
    }

    #[test]
    #[ignore = "set DEGREE_STUDY_DIAGNOSTIC_DB to build the compact index in an existing database"]
    fn existing_database_index_can_be_built_and_read() {
        let path = env::var("DEGREE_STUDY_DIAGNOSTIC_DB").expect("set DEGREE_STUDY_DIAGNOSTIC_DB");
        let connection = Connection::open(path).expect("open existing database");
        initialize_schema(&connection).expect("initialize index schema");
        let started = Instant::now();
        let index = read_database_index(&connection).expect("build and read record index");
        for collection in COLLECTIONS {
            let records = index["database"][collection]
                .as_array()
                .expect("indexed collection");
            println!("{collection}: indexed {} records", records.len());
        }
        let note = index["database"]["notes"][0].clone();
        let note_id = note["id"].as_str().expect("indexed note id");
        assert_eq!(
            read_database_record(&connection, "notes", note_id).expect("read full note")["id"],
            note_id
        );
        println!(
            "index build and first full-record read: {:.2?}",
            started.elapsed()
        );
    }

    #[test]
    fn desktop_database_routes_use_native_sqlite_without_starting_the_worker() {
        let directory = env::temp_dir().join(format!(
            "degree-study-manager-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("current time")
                .as_nanos()
        ));
        let database_file = directory.join("degree-study-manager.sqlite");
        let mut state = ApiState {
            process: None,
            database: None,
            database_path: Some(database_file.clone()),
            runtime_directory: None,
            node_executable: None,
            log_path: None,
            request_id: 1,
            request_chunks: HashMap::new(),
            response_chunks: HashMap::new(),
        };

        let empty = dispatch_api_request(
            &mut state,
            "GET".to_string(),
            "/api/database".to_string(),
            None,
        )
        .expect("read native database");
        assert_eq!(empty["status"], 200);
        assert_eq!(state.process.is_none(), true);

        let mut data = empty_database();
        data["degrees"] = serde_json::json!([{"id":"degree-1","name":"Saved locally"}]);
        let saved = dispatch_api_request(
            &mut state,
            "PUT".to_string(),
            "/api/database".to_string(),
            Some(data.clone()),
        )
        .expect("save native database");
        assert_eq!(saved["status"], 200);

        let loaded = dispatch_api_request(
            &mut state,
            "GET".to_string(),
            "/api/database".to_string(),
            None,
        )
        .expect("reload native database");
        let body: serde_json::Value =
            serde_json::from_str(loaded["body"].as_str().expect("database body"))
                .expect("decode database response");
        assert_eq!(body, data);
        assert!(state.process.is_none());

        drop(state);
        let _ = remove_file(&database_file);
        let _ = remove_file(database_file.with_extension("sqlite-wal"));
        let _ = remove_file(database_file.with_extension("sqlite-shm"));
        let _ = std::fs::remove_dir(directory);
    }
}

fn start_api_worker(
    runtime_directory: &Path,
    node_executable: &Path,
    log_path: &Path,
) -> Result<ApiProcess, Box<dyn Error>> {
    if let Some(directory) = log_path.parent() {
        create_dir_all(directory)?;
    }
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(node_executable);
    command
        .arg("server.js")
        .arg("--desktop-ipc")
        .current_dir(runtime_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log_file));

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Unable to open the local storage runtime input."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Unable to open the local storage runtime output."))?;
    Ok(ApiProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        request_id: 1,
    })
}

fn prune_transfers(state: &mut ApiState) {
    state
        .request_chunks
        .retain(|_, transfer| transfer.created.elapsed() < TRANSFER_TIMEOUT);
    state
        .response_chunks
        .retain(|_, transfer| transfer.created.elapsed() < TRANSFER_TIMEOUT);
}

fn ensure_api_worker(state: &mut ApiState) -> Result<(), String> {
    let exited = state
        .process
        .as_mut()
        .map(|process| process.child.try_wait())
        .transpose()
        .map_err(|error| format!("Unable to check the local storage runtime: {error}"))?
        .flatten()
        .is_some();
    if exited {
        state.process = None;
    }
    if state.process.is_none() {
        let runtime_directory = state
            .runtime_directory
            .as_ref()
            .ok_or_else(|| "The optional workspace runtime path is unavailable.".to_string())?;
        let node_executable = state
            .node_executable
            .as_ref()
            .ok_or_else(|| "The optional workspace runtime path is unavailable.".to_string())?;
        let log_path = state
            .log_path
            .as_ref()
            .ok_or_else(|| "The optional workspace runtime log path is unavailable.".to_string())?;
        state.process = Some(
            start_api_worker(runtime_directory, node_executable, log_path).map_err(|error| {
                format!("Unable to start the optional workspace runtime: {error}")
            })?,
        );
    }
    Ok(())
}

fn dispatch_api_request(
    state: &mut ApiState,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !path.starts_with("/api/") || path.contains('\n') || path.contains('\r') {
        return Err("The requested local API path is invalid.".to_string());
    }
    if !matches!(method.as_str(), "GET" | "POST" | "PUT") {
        return Err("The requested local API method is not supported.".to_string());
    }
    let request_id = state.request_id;
    state.request_id = state.request_id.wrapping_add(1);

    let native_response = match (path.as_str(), method.as_str()) {
        ("/api/database", "GET") => {
            let connection = ensure_database(state)?;
            Some((200, read_database(connection)?))
        }
        ("/api/database", "PUT") => {
            let Some(data) = body.as_ref() else {
                return json_api_response(
                    state,
                    request_id,
                    400,
                    serde_json::json!({"error":"The database backup has an invalid format."}),
                );
            };
            let connection = ensure_database(state)?;
            match replace_database(connection, data) {
                Ok(()) => Some((200, serde_json::json!({"ok":true}))),
                Err(error) if error.starts_with("The ") || error.starts_with("A record") => {
                    return json_api_response(
                        state,
                        request_id,
                        400,
                        serde_json::json!({"error":error}),
                    );
                }
                Err(error) => return Err(error),
            }
        }
        ("/api/changes", "POST") => {
            let Some(changes) = body.as_ref() else {
                return json_api_response(
                    state,
                    request_id,
                    400,
                    serde_json::json!({"error":"Database changes have an invalid format."}),
                );
            };
            let connection = ensure_database(state)?;
            match apply_database_changes(connection, changes) {
                Ok(()) => Some((200, serde_json::json!({"ok":true}))),
                Err(error)
                    if error.starts_with("Database changes")
                        || error.contains("collection")
                        || error.contains("delete list")
                        || error.contains("invalid id") =>
                {
                    return json_api_response(
                        state,
                        request_id,
                        400,
                        serde_json::json!({"error":error}),
                    );
                }
                Err(error) => return Err(error),
            }
        }
        ("/api/database", _) | ("/api/changes", _) => {
            return json_api_response(
                state,
                request_id,
                405,
                serde_json::json!({"error":"Method not allowed."}),
            );
        }
        _ => None,
    };
    if let Some((status, body)) = native_response {
        return json_api_response(state, request_id, status, body);
    }

    ensure_api_worker(state)?;
    let process = state
        .process
        .as_mut()
        .ok_or_else(|| "The local storage runtime is unavailable.".to_string())?;
    let worker_request_id = process.request_id;
    process.request_id = process.request_id.wrapping_add(1);
    let request = serde_json::json!({
        "requestId": worker_request_id,
        "method": method,
        "path": path,
        "body": body
    });
    serde_json::to_writer(&mut process.stdin, &request)
        .map_err(|error| format!("Unable to send a local storage request: {error}"))?;
    process
        .stdin
        .write_all(b"\n")
        .and_then(|_| process.stdin.flush())
        .map_err(|error| format!("Unable to send a local storage request: {error}"))?;

    let mut line = String::new();
    process
        .stdout
        .read_line(&mut line)
        .map_err(|error| format!("Unable to read a local storage response: {error}"))?;
    if line.is_empty() {
        return Err("The local storage runtime closed its response stream.".to_string());
    }
    let response: serde_json::Value = serde_json::from_str(&line).map_err(|error| {
        format!("The local storage runtime returned an invalid response: {error}")
    })?;
    if response["requestId"].as_u64() != Some(worker_request_id) {
        return Err("The local storage runtime returned a mismatched response.".to_string());
    }
    if line.len() > MAX_IPC_CHUNK_BYTES {
        let response_id = format!("response-{request_id}");
        state.response_chunks.insert(
            response_id.clone(),
            Transfer {
                content: line,
                created: Instant::now(),
            },
        );
        return Ok(serde_json::json!({ "chunkedResponseId": response_id }));
    }
    Ok(response)
}

fn read_database_page(
    connection: &Connection,
    collection: &str,
    offset: usize,
    max_bytes: usize,
) -> Result<serde_json::Value, String> {
    if !COLLECTIONS.contains(&collection) {
        return Err("The requested local database collection is invalid.".to_string());
    }
    if max_bytes == 0 || max_bytes > 16 * 1024 * 1024 {
        return Err("The local database page size is invalid.".to_string());
    }
    let total: usize = connection
        .query_row(
            "SELECT COUNT(*) FROM records WHERE collection = ?1",
            [collection],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Unable to count local {collection} records: {error}"))?
        .try_into()
        .map_err(|_| format!("The local {collection} record count is invalid."))?;
    if offset > total {
        return Err("The local database page offset is invalid.".to_string());
    }

    let mut statement = connection
        .prepare(
            "SELECT payload FROM records
             WHERE collection = ?1
             ORDER BY id
             LIMIT 32 OFFSET ?2",
        )
        .map_err(|error| format!("Unable to prepare a local {collection} page: {error}"))?;
    let mut rows = statement
        .query(rusqlite::params![collection, offset as i64])
        .map_err(|error| format!("Unable to query local {collection} records: {error}"))?;
    let mut records = Vec::new();
    let mut page_bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Unable to read local {collection} records: {error}"))?
    {
        let payload: String = row
            .get(0)
            .map_err(|error| format!("Unable to read a local {collection} record: {error}"))?;
        let payload_bytes = payload.len();
        let record: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|error| format!("A saved {collection} record is invalid: {error}"))?;
        records.push(record);
        page_bytes = page_bytes.saturating_add(payload_bytes);
        if page_bytes >= max_bytes {
            break;
        }
    }
    let next_offset = offset.saturating_add(records.len());
    Ok(serde_json::json!({
        "records":records,
        "nextOffset":next_offset,
        "total":total,
        "complete":next_offset >= total
    }))
}

#[tauri::command]
async fn desktop_database_page(
    runtime: tauri::State<'_, ApiRuntime>,
    collection: String,
    offset: usize,
    max_bytes: usize,
) -> Result<serde_json::Value, String> {
    if !COLLECTIONS.contains(&collection.as_str()) {
        return Err("The requested local database collection is invalid.".to_string());
    }
    if max_bytes == 0 || max_bytes > 16 * 1024 * 1024 {
        return Err("The local database page size is invalid.".to_string());
    }
    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local SQLite database is unavailable.".to_string())?;
        let connection = ensure_database(&mut state)?;
        read_database_page(connection, &collection, offset, max_bytes)
    })
    .await
    .map_err(|error| format!("The local database read failed: {error}"))?
}

#[tauri::command]
async fn desktop_database_index(
    runtime: tauri::State<'_, ApiRuntime>,
) -> Result<serde_json::Value, String> {
    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local SQLite database is unavailable.".to_string())?;
        let connection = ensure_database(&mut state)?;
        read_database_index(connection)
    })
    .await
    .map_err(|error| format!("The local database index read failed: {error}"))?
}

#[tauri::command]
async fn desktop_database_record(
    runtime: tauri::State<'_, ApiRuntime>,
    collection: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local SQLite database is unavailable.".to_string())?;
        let connection = ensure_database(&mut state)?;
        read_database_record(connection, &collection, &id)
    })
    .await
    .map_err(|error| format!("The local database record read failed: {error}"))?
}

fn json_api_response(
    state: &mut ApiState,
    request_id: u64,
    status: u16,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body = serde_json::to_string(&body)
        .map_err(|error| format!("Unable to encode a local database response: {error}"))?;
    let response = serde_json::json!({
        "requestId":request_id,
        "status":status,
        "headers":{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},
        "body":body
    });
    let serialized = serde_json::to_string(&response)
        .map_err(|error| format!("Unable to encode a local database response: {error}"))?;
    if serialized.len() <= MAX_IPC_CHUNK_BYTES {
        return Ok(response);
    }
    let response_id = format!("response-{request_id}");
    state.response_chunks.insert(
        response_id.clone(),
        Transfer {
            content: serialized,
            created: Instant::now(),
        },
    );
    Ok(serde_json::json!({"chunkedResponseId":response_id}))
}

#[tauri::command]
async fn desktop_api_request(
    runtime: tauri::State<'_, ApiRuntime>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local storage runtime is unavailable.".to_string())?;
        prune_transfers(&mut state);
        dispatch_api_request(&mut state, method, path, body)
    })
    .await
    .map_err(|error| format!("The local storage request failed: {error}"))?
}

#[tauri::command]
async fn desktop_api_request_chunk(
    runtime: tauri::State<'_, ApiRuntime>,
    upload_id: String,
    method: String,
    path: String,
    chunk: String,
    final_chunk: bool,
) -> Result<serde_json::Value, String> {
    if upload_id.is_empty()
        || upload_id.len() > 80
        || !upload_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("The local request upload id is invalid.".to_string());
    }
    if chunk.len() > MAX_IPC_CHUNK_BYTES {
        return Err("The local request chunk is too large.".to_string());
    }

    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local storage runtime is unavailable.".to_string())?;
        prune_transfers(&mut state);
        let transfer = state
            .request_chunks
            .entry(upload_id.clone())
            .or_insert_with(|| Transfer {
                content: String::new(),
                created: Instant::now(),
            });
        if transfer.content.len().saturating_add(chunk.len()) > MAX_REQUEST_BODY_BYTES {
            state.request_chunks.remove(&upload_id);
            return Err("The local request exceeds the 150 MB limit.".to_string());
        }
        transfer.content.push_str(&chunk);
        if !final_chunk {
            return Ok(serde_json::json!({ "queued": true }));
        }

        let content = state
            .request_chunks
            .remove(&upload_id)
            .ok_or_else(|| "The local request upload expired.".to_string())?
            .content;
        let body = serde_json::from_str(&content)
            .map_err(|error| format!("The uploaded local request is invalid JSON: {error}"))?;
        dispatch_api_request(&mut state, method, path, Some(body))
    })
    .await
    .map_err(|error| format!("The local request upload failed: {error}"))?
}

#[tauri::command]
async fn desktop_api_response_chunk(
    runtime: tauri::State<'_, ApiRuntime>,
    response_id: String,
    offset: usize,
    max_bytes: usize,
) -> Result<serde_json::Value, String> {
    if max_bytes == 0 || max_bytes > MAX_IPC_CHUNK_BYTES {
        return Err("The local response chunk size is invalid.".to_string());
    }
    let runtime = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = runtime
            .lock()
            .map_err(|_| "The local storage runtime is unavailable.".to_string())?;
        prune_transfers(&mut state);
        let transfer = state
            .response_chunks
            .get(&response_id)
            .ok_or_else(|| "The local response has expired.".to_string())?;
        if offset > transfer.content.len() || !transfer.content.is_char_boundary(offset) {
            return Err("The local response offset is invalid.".to_string());
        }
        let mut end = offset.saturating_add(max_bytes).min(transfer.content.len());
        while !transfer.content.is_char_boundary(end) {
            end -= 1;
        }
        let chunk = transfer.content[offset..end].to_string();
        let complete = end == transfer.content.len();
        if complete {
            state.response_chunks.remove(&response_id);
        }
        Ok(serde_json::json!({
            "chunk": chunk,
            "nextOffset": end,
            "complete": complete
        }))
    })
    .await
    .map_err(|error| format!("The local response transfer failed: {error}"))?
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let Some((scheme, remainder)) = url.split_once("://") else {
        return Err("Only HTTP and HTTPS PDF links can be opened.".to_string());
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || remainder.is_empty()
        || remainder.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '\\'
        })
        || remainder
            .split(['/', '?', '#'])
            .next()
            .is_none_or(|authority| authority.is_empty() || authority.contains('@'))
    {
        return Err("The PDF link is not a valid HTTP or HTTPS address.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

        let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("Windows could not open this PDF link in the browser.".to_string());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Opening PDF links in the system browser is only supported on Windows.".to_string())
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_api_request,
            desktop_database_index,
            desktop_database_page,
            desktop_database_record,
            desktop_api_request_chunk,
            desktop_api_response_chunk,
            open_external_url
        ])
        .setup(|app| {
            let runtime_paths = runtime_paths(app.handle()).ok();

            app.manage(ApiRuntime(Arc::new(Mutex::new(ApiState {
                process: None,
                database: None,
                database_path: database_path().ok(),
                runtime_directory: runtime_paths
                    .as_ref()
                    .map(|(directory, _)| directory.clone()),
                node_executable: runtime_paths.map(|(_, executable)| executable),
                log_path: Some(runtime_log_path()),
                request_id: 1,
                request_chunks: HashMap::new(),
                response_chunks: HashMap::new(),
            }))));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Degree Study Manager")
                .inner_size(1400.0, 900.0)
                .min_inner_size(800.0, 600.0)
                .center()
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(runtime) = handle.try_state::<ApiRuntime>() {
                    if let Ok(mut state) = runtime.0.lock() {
                        if let Some(process) = state.process.as_mut() {
                            let _ = process.child.kill();
                            let _ = process.child.wait();
                        }
                    }
                }
            }
        }),
        Err(error) => show_startup_error(&format!("The desktop app could not start.\n\n{error}")),
    }
}

fn show_startup_error(message: &str) {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    let message: Vec<u16> = OsStr::new(message).encode_wide().chain(once(0)).collect();
    let title: Vec<u16> = OsStr::new("Degree Study Manager")
        .encode_wide()
        .chain(once(0))
        .collect();

    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
}
