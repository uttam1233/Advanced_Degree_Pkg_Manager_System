import ast
import codeop
import json
import queue
import re
import shutil
import sys
import threading
import traceback

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager


write_lock = threading.Lock()
kernel_client = None
active_execution = None
ansi_escape = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])"
)
control_characters = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def emit(message):
    def clean(value):
        if isinstance(value, str):
            return control_characters.sub("", ansi_escape.sub("", value))
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()}
        return value

    with write_lock:
        sys.stdout.write(json.dumps(clean(message), ensure_ascii=False) + "\n")
        sys.stdout.flush()


def list_kernels():
    manager = KernelSpecManager()
    kernels = [
        {
            "name": name,
            "displayName": details["spec"].get("display_name", name),
            "language": details["spec"].get("language", "unknown"),
        }
        for name, details in manager.get_all_specs().items()
        if details["spec"].get("argv")
        and shutil.which(details["spec"]["argv"][0]) is not None
    ]
    emit({"event": "kernels", "kernels": kernels})


def execute_code(request):
    global active_execution
    request_id = request["requestId"]
    try:
        message_id = kernel_client.execute(request["code"], allow_stdin=True)
        execution_count = None
        failed = False

        while True:
            try:
                message = kernel_client.get_iopub_msg(timeout=0.1)
                if message.get("parent_header", {}).get("msg_id") == message_id:
                    content = message["content"]
                    message_type = message["header"]["msg_type"]
                    if message_type == "execute_input":
                        execution_count = content.get("execution_count", execution_count)
                    elif message_type == "stream":
                        emit(
                            {
                                "event": "output",
                                "requestId": request_id,
                                "output": {
                                    "type": "stream",
                                    "name": content.get("name", "stdout"),
                                    "text": content.get("text", ""),
                                },
                            }
                        )
                    elif message_type in ("execute_result", "display_data"):
                        execution_count = content.get("execution_count", execution_count)
                        emit(
                            {
                                "event": "output",
                                "requestId": request_id,
                                "output": {
                                    "type": message_type,
                                    "data": content.get("data", {}),
                                    "metadata": content.get("metadata", {}),
                                    "executionCount": content.get("execution_count"),
                                },
                            }
                        )
                    elif message_type == "error":
                        failed = True
                        emit(
                            {
                                "event": "output",
                                "requestId": request_id,
                                "output": {
                                    "type": "error",
                                    "ename": content.get("ename", "Error"),
                                    "evalue": content.get("evalue", ""),
                                    "traceback": content.get("traceback", []),
                                },
                            }
                        )
                    elif message_type == "status" and content.get("execution_state") == "idle":
                        break
            except queue.Empty:
                pass

            try:
                stdin_message = kernel_client.get_stdin_msg(timeout=0.01)
                if (
                    stdin_message.get("header", {}).get("msg_type") == "input_request"
                    and stdin_message.get("parent_header", {}).get("msg_id") == message_id
                ):
                    emit(
                        {
                            "event": "input_request",
                            "requestId": request_id,
                            "prompt": stdin_message["content"].get("prompt", ""),
                        }
                    )
            except queue.Empty:
                pass

        emit(
            {
                "event": "execution_finished",
                "requestId": request_id,
                "ok": not failed,
                "executionCount": execution_count,
            }
        )
    except Exception as error:
        emit({"event": "request_error", "requestId": request_id, "message": str(error)})
    finally:
        active_execution = None


def inspect_code(request):
    request_id = request["requestId"]
    try:
        message_id = kernel_client.inspect(
            request["code"],
            request["cursorPos"],
            detail_level=1,
        )
        while True:
            message = kernel_client.get_shell_msg(timeout=5)
            if message.get("parent_header", {}).get("msg_id") == message_id:
                break

        content = message.get("content", {})
        data = content.get("data", {})
        text = data.get("text/plain", "")
        if isinstance(text, list):
            text = "".join(text)
        emit(
            {
                "event": "inspection_finished",
                "requestId": request_id,
                "found": bool(content.get("found")),
                "text": text[:20000] if isinstance(text, str) else "",
            }
        )
    except Exception as error:
        emit({"event": "request_error", "requestId": request_id, "message": str(error)})


def complete_code(request):
    request_id = request["requestId"]
    try:
        message_id = kernel_client.complete(
            request["code"],
            request["cursorPos"],
        )
        while True:
            message = kernel_client.get_shell_msg(timeout=5)
            if message.get("parent_header", {}).get("msg_id") == message_id:
                break

        content = message.get("content", {})
        emit(
            {
                "event": "completion_finished",
                "requestId": request_id,
                "matches": content.get("matches", []),
                "cursorStart": content.get("cursor_start", request["cursorPos"]),
                "cursorEnd": content.get("cursor_end", request["cursorPos"]),
                "metadata": content.get("metadata", {}),
            }
        )
    except Exception as error:
        emit({"event": "request_error", "requestId": request_id, "message": str(error)})


def validate_code(request):
    source = request["code"]
    lines = source.splitlines(keepends=True)
    first_code_line = next((line.lstrip() for line in lines if line.strip()), "")
    if first_code_line.startswith("%%"):
        emit({"event": "validation_finished", "requestId": request["requestId"], "diagnostics": []})
        return
    transformed_source = "".join(
        "\n" if line.lstrip().startswith(("%", "!")) else line for line in lines
    )
    try:
        codeop.compile_command(transformed_source, "<notebook>", "exec")
        diagnostic = None
    except SyntaxError:
        try:
            compile(
                transformed_source,
                "<notebook>",
                "exec",
                flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
                dont_inherit=True,
            )
            diagnostic = None
        except SyntaxError as error:
            diagnostic = {
                "line": max(0, (error.lineno or 1) - 1),
                "column": max(0, (error.offset or 1) - 1),
                "message": error.msg,
            }
    except (OverflowError, ValueError) as error:
        diagnostic = {
            "line": 0,
            "column": 0,
            "message": str(error),
        }

    emit(
        {
            "event": "validation_finished",
            "requestId": request["requestId"],
            "diagnostics": [diagnostic] if diagnostic else [],
        }
    )


def run_kernel(kernel_name, working_directory):
    global active_execution, kernel_client
    manager = KernelSpecManager()
    if kernel_name not in manager.get_all_specs():
        raise ValueError("The selected Jupyter kernel is no longer installed.")
    kernel_manager = KernelManager(
        kernel_name=kernel_name,
        kernel_spec_manager=manager,
    )
    kernel_manager.start_kernel(cwd=working_directory)
    kernel_client = kernel_manager.client()
    kernel_client.start_channels()
    kernel_client.wait_for_ready(timeout=90)
    emit({"event": "ready"})

    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                action = request.get("action")
                if action == "execute":
                    if active_execution is not None:
                        emit(
                            {
                                "event": "request_error",
                                "requestId": request.get("requestId"),
                                "message": "A notebook cell is already running.",
                            }
                        )
                        continue
                    active_execution = request["requestId"]
                    emit({"event": "execution_started", "requestId": active_execution})
                    threading.Thread(
                        target=execute_code,
                        args=(request,),
                        daemon=True,
                    ).start()
                elif action == "inspect":
                    if active_execution is not None:
                        emit(
                            {
                                "event": "request_error",
                                "requestId": request.get("requestId"),
                                "message": "Wait for the running cell to finish before requesting documentation.",
                            }
                        )
                        continue
                    inspect_code(request)
                elif action == "complete":
                    if active_execution is not None:
                        emit(
                            {
                                "event": "request_error",
                                "requestId": request.get("requestId"),
                                "message": "Wait for the running notebook cell to finish before requesting completions.",
                            }
                        )
                        continue
                    complete_code(request)
                elif action == "validate":
                    validate_code(request)
                elif action == "input":
                    if request.get("requestId") != active_execution:
                        emit(
                            {
                                "event": "request_error",
                                "requestId": request.get("requestId"),
                                "message": "The running cell is no longer accepting input.",
                            }
                        )
                        continue
                    kernel_client.input(request.get("value", ""))
                    emit({"event": "input_sent", "requestId": active_execution})
                elif action == "shutdown":
                    break
                else:
                    emit(
                        {
                            "event": "request_error",
                            "requestId": request.get("requestId"),
                            "message": "Unknown notebook action.",
                        }
                    )
            except (ValueError, KeyError) as error:
                emit(
                    {
                        "event": "request_error",
                        "requestId": request.get("requestId"),
                        "message": str(error),
                    }
                )
    finally:
        kernel_manager.shutdown_kernel(now=True)
        kernel_client.stop_channels()


def main():
    if sys.argv[1:] == ["--list"]:
        list_kernels()
        return
    if len(sys.argv) != 3:
        raise ValueError("Kernel name and working directory are required.")
    run_kernel(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(
            {
                "event": "error",
                "message": str(error),
                "traceback": traceback.format_exc(),
            }
        )
