import {open,rename,mkdir,readFile,link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {canonical} from '@faultline/protocol';
import {dirname,join} from 'node:path';
import type {SignedRecord,SigningJournal} from '../../apps/worker/src/signer';
export async function atomicJson(path:string,value:unknown){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const tmp=`${path}.${process.pid}.tmp`,f=await open(tmp,'w',0o600);
 try{await f.writeFile(JSON.stringify(value,null,2));await f.sync();}finally{await f.close();}await rename(tmp,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function readJson<T>(path:string):Promise<T|null>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
/** Publish a complete immutable artifact atomically. Concurrent retries can only reuse identical bytes. */
export async function immutableJson(path:string,value:unknown){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const bytes=canonical(value),tmp=`${path}.${randomUUID()}.tmp`,file=await open(tmp,'wx',0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 try{
  try{await link(tmp,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await readFile(path,'utf8')!==bytes)throw new Error('Immutable evidence conflict; the original artifact is preserved');}
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
 }finally{await unlink(tmp);}
}
/** Requires the runner's exclusive directory lock. Signed bytes never enter exported audit files. */
export class FileSigningJournal implements SigningJournal {
 constructor(private path:string){}
 private async all(){return await readJson<Record<string,SignedRecord>>(this.path)??{};}
 async get(id:string){return (await this.all())[id]??null;}
 async latestNonce(chainId:number,from:string){return Math.max(-1,...Object.values(await this.all()).filter(r=>r.chainId===chainId&&r.from===from).map(r=>r.nonce));}
 async insert(record:SignedRecord){const all=await this.all(),old=all[record._id];if(old){if(old.intentHash!==record.intentHash)throw new Error('Immutable journal conflict');return old;}if(Object.values(all).some(r=>r.chainId===record.chainId&&r.from===record.from&&r.nonce===record.nonce))throw new Error('Nonce already reserved');all[record._id]=record;await atomicJson(this.path,all);return record;}
 async setLogicalHash(id:string,hash:string){const all=await this.all(),r=all[id];if(!r||r.logicalHash&&r.logicalHash!==hash)throw new Error('Logical transaction conflict');r.logicalHash=hash;await atomicJson(this.path,all);}
}
