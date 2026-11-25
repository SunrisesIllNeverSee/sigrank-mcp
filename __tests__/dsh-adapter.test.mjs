import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDshSession, dshAdapter } from "../adapters/dsh.mjs";
const time = 1785015045000;
const header = (id="s1", extra={})=>({type:"session",id,createdAt:time,...extra});
const event = (seq,usage)=>({type:"assistant/message",seq,time,data:{usage}});
const jsonl = (...rows)=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
const path = "/tmp/session.v4.jsonl";
test("disjoint pillars, output recovery, route and last streamed usage",()=>{
  const records=parseDshSession(jsonl(header(),
    {type:"request/header",data:{header:{config:{model:"deepseek-v4-pro"}}}},
    event(1,{inputTokens:1200,outputTokens:300,cacheReadTokens:8000,cacheWriteTokens:20,totalTokens:9520}),
    event(2,{inputTokens:5,cacheReadTokens:3,totalTokens:10}),
    {type:"assistant/attempt",seq:3,time,data:{stream:[
      {type:"chunk",chunk:{type:"usage",usage:{inputTokens:2}}},
      {type:"chunk",chunk:{type:"usage",usage:{inputTokens:4,outputTokens:1}}}
    ]}}
  ),path);
  assert.deepEqual(records.map(r=>[r.input,r.output,r.cacheCreate,r.cacheRead]),[[1200,300,20,8000],[5,2,0,3],[4,1,0,0]]);
  assert.equal(records[0].model,"deepseek-v4-pro");
});
test("forks count only after last inherited marker",()=>{
  const marker={type:"session/end-seed",data:{inherited:true}};
  assert.deepEqual(parseDshSession(jsonl(header("fork",{isSeeded:true}),event(1,{inputTokens:9}),marker,event(2,{inputTokens:8}),marker,event(3,{inputTokens:7})),path).map(r=>r.input),[7]);
  assert.deepEqual(parseDshSession(jsonl(header("fork",{isSeeded:true}),event(1,{inputTokens:9})),path),[]);
});
test("unallocated totals and malformed interior records fail closed",()=>{
  assert.throws(()=>parseDshSession(jsonl(header(),event(1,{inputTokens:2,outputTokens:1,totalTokens:10})),path),/not attributable/);
  assert.throws(()=>parseDshSession(jsonl(header())+"bad\n"+jsonl(event(1,{inputTokens:3})),path),/malformed/);
});
test("latest generation and duplicated roots do not double count",async()=>{
  const root=await mkdtemp(join(tmpdir(),"sigrank-dsh-"));
  const oldEnv=process.env.DSH_HOME;
  try{
    const a=join(root,"a"),b=join(root,"b");
    for(const r of [a,b]){
      const dir=join(r,"sessions","p","s1");await mkdir(dir,{recursive:true});
      await writeFile(join(dir,"session.jsonl"),jsonl(header(),event(1,{inputTokens:100})));
      await writeFile(join(dir,"session.v4.jsonl"),jsonl(header(),event(1,{inputTokens:r===a?5:7})));
    }
    process.env.DSH_HOME=a+","+b;
    const rows=[];for await(const row of dshAdapter.messages(root))rows.push(row);
    assert.equal(rows.length,1);assert.equal(rows[0].input,7);
  }finally{if(oldEnv===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldEnv;await rm(root,{recursive:true,force:true});}
});
