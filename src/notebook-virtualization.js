export class CellHeightIndex {
 constructor(heights){
  this.size=heights.length;
  this.highestBit=this.size?2**Math.floor(Math.log2(this.size)):0;
  this.tree=new Float64Array(this.size+1);
  this.values=Array.from(heights);
  for(let index=1;index<=this.size;index++){
   this.tree[index]+=this.values[index-1];
   const parent=index+(index&-index);
   if(parent<=this.size)this.tree[parent]+=this.tree[index];
  }
 }

 #add(index,delta){
  for(let position=index+1;position<=this.size;position+=position&-position)this.tree[position]+=delta;
 }

 update(index,height){
  if(!Number.isInteger(index)||index<0||index>=this.size||!Number.isFinite(height)||height<=0)return false;
  const delta=height-this.values[index];
  if(Math.abs(delta)<0.01)return false;
  this.values[index]=height;
  this.#add(index,delta);
  return true;
 }

 prefix(end){
  let total=0;
  for(let position=Math.min(end,this.size);position>0;position-=position&-position)total+=this.tree[position];
  return total;
 }

 get total(){
  return this.prefix(this.size);
 }

 indexAt(offset){
  if(this.size===0)return-1;
  if(offset<=0)return 0;
  if(offset>=this.total)return this.size-1;
  let index=0,total=0;
  for(let bit=this.highestBit;bit>0;bit=Math.floor(bit/2)){
   const next=index+bit;
   if(next<=this.size&&total+this.tree[next]<=offset){
    index=next;
    total+=this.tree[next];
   }
  }
  return Math.min(index,this.size-1);
 }
}
