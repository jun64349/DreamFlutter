import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inventory, mib } from './package-footprint.mjs';
import { plan } from './package-trim.mjs';

const [before, after, manifest, evidence] = process.argv.slice(2);
assert.ok(before && after && manifest && evidence);
const removed = new Set(JSON.parse(readFileSync(manifest,'utf8')).candidates.map(f=>f.path));
const hash = async path => {const digest=createHash('sha256');for await(const bytes of createReadStream(path))digest.update(bytes);return digest.digest('hex');};
const old=inventory(before),next=inventory(after),names=new Map(next.map(f=>[f.path,f])),proof={at:new Date().toISOString(),before:resolve(before),after:resolve(after),verifiedFiles:0,verifiedBytes:0,removedFiles:0,removedBytes:0,passed:false};
const retained=[];
for(const file of old){
  if(removed.has(file.path)){assert.ok(!names.has(file.path));proof.removedFiles++;proof.removedBytes+=file.bytes;}else retained.push(file);
}
async function verify(file){
  assert.equal(names.get(file.path)?.bytes,file.bytes,file.path);
  const [actual,expected]=await Promise.all([hash(join(after,file.path)),hash(join(before,file.path))]);assert.equal(actual,expected,file.path);
  proof.verifiedFiles++;proof.verifiedBytes+=file.bytes;names.delete(file.path);
}
for(let i=0;i<retained.length;i+=16){await Promise.all(retained.slice(i,i+16).map(verify));if(i%4096===0)console.log(`Verified ${Math.min(i+16,retained.length)}/${retained.length} retained files`);}
assert.equal(names.size,0,'No unexplained files may appear in the compared payload');
const rerun=plan(after);assert.equal(rerun.savedBytes,0,'Applying the reviewed trimming policy twice must be idempotent');
const licenses=JSON.parse(readFileSync(join(after,'licenses/third-party.json'),'utf8'));
for(const item of licenses.entries)if(item.path)assert.ok(existsSync(join(after,item.path)),item.path);
proof.licenseEntries=licenses.entries.length;proof.verifiedMiB=mib(proof.verifiedBytes);proof.removedMiB=mib(proof.removedBytes);proof.passed=true;
writeFileSync(evidence,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
