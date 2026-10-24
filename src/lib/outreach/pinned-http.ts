import { request } from "node:https";

export type PageResponse = { status:number; location?:string; type:string; html:string };
type Connection = { read(buffer:Uint8Array):Promise<number|null>; write(buffer:Uint8Array):Promise<number>; close():void };
type EdgeNetwork = { connect(options:{hostname:string;port:number}):Promise<Connection>; startTls(connection:Connection,options:{hostname:string}):Promise<Connection> };
const LIMIT=2000000;

export function decodeHttpResponse(raw:Buffer):PageResponse {
  const end=raw.indexOf("\r\n\r\n");
  if(end<0 || end>16384)throw new Error("Invalid or oversized website headers");
  const lines=raw.subarray(0,end).toString("latin1").split("\r\n");
  const status=Number(lines.shift()?.match(/^HTTP\/1\.[01] (\d{3})\b/)?.[1]);
  if(!status)throw new Error("Invalid website HTTP status");
  const headers=new Headers();
  for(const line of lines){const colon=line.indexOf(":");if(colon>0)headers.append(line.slice(0,colon),line.slice(colon+1).trim());}
  if(headers.get("content-encoding") && headers.get("content-encoding")!=="identity")throw new Error("Unexpected compressed website response");
  let body=raw.subarray(end+4);
  if(/\bchunked\b/i.test(headers.get("transfer-encoding")||"")) {
    const chunks:Buffer[]=[];let offset=0;let total=0;let finished=false;
    while(offset<body.length){
      const lineEnd=body.indexOf("\r\n",offset);if(lineEnd<0||lineEnd-offset>200)throw new Error("Invalid chunked response");
      const line=body.subarray(offset,lineEnd).toString("ascii").split(";")[0];
      if(!/^[0-9a-f]+$/i.test(line))throw new Error("Invalid chunk size");
      const size=Number.parseInt(line,16);offset=lineEnd+2;
      if(size===0){finished=true;break;}
      total+=size;if(total>LIMIT||offset+size+2>body.length)throw new Error("Website body incomplete or too large");
      if(body.subarray(offset+size,offset+size+2).toString()!=="\r\n")throw new Error("Invalid chunk terminator");
      chunks.push(body.subarray(offset,offset+size));offset+=size+2;
    }
    if(!finished)throw new Error("Incomplete chunked response");body=Buffer.concat(chunks);
  }else if(headers.has("content-length")) {
    const size=Number(headers.get("content-length"));
    if(!Number.isSafeInteger(size)||size<0||size>LIMIT||body.length<size)throw new Error("Website body incomplete or too large");
    body=body.subarray(0,size);
  }
  if(body.length>LIMIT)throw new Error("Website body too large");
  return {status,location:headers.get("location")||undefined,type:headers.get("content-type")||"",html:body.toString("utf8")};
}

async function edgeRequest(url:URL,ip:string,network:EdgeNetwork):Promise<PageResponse> {
  let connection:Connection|undefined;let expired=false;
  const close=()=>{try{connection?.close();}catch{}};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([
      (async()=>{
        connection=await network.connect({hostname:ip,port:443});if(expired){close();throw new Error("Website timeout");}
        // Upgrade the pinned socket using the original hostname for SNI and certificate verification.
        connection=await network.startTls(connection,{hostname:url.hostname});if(expired){close();throw new Error("Website timeout");}
        const data=new TextEncoder().encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: OritResearch/1.0 (+https://orit.dev; oritsoftware@gmail.com)\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
        let sent=0;while(sent<data.length){const n=await connection.write(data.subarray(sent));if(n<=0)throw new Error("Website write failed");sent+=n;}
        const chunks:Buffer[]=[];let bytes=0;
        while(true){const buffer=new Uint8Array(32768);const n=await connection.read(buffer);if(n===null)break;if(n===0)continue;bytes+=n;if(bytes>LIMIT+65536)throw new Error("Website body too large");chunks.push(Buffer.from(buffer.subarray(0,n)));}
        return decodeHttpResponse(Buffer.concat(chunks));
      })(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;close();reject(new Error("Website timeout"));},8000);}),
    ]);
  }finally{if(timer)clearTimeout(timer);close();}
}
export async function pinnedHttps(url:URL,ip:string):Promise<PageResponse> {
  const runtime=(globalThis as unknown as {Deno?:EdgeNetwork}).Deno;
  if(runtime && typeof runtime.connect==="function" && typeof runtime.startTls==="function")return edgeRequest(url,ip,runtime);
  return new Promise((resolve,reject)=>{
    const req=request(url,{hostname:ip,servername:url.hostname,rejectUnauthorized:true,headers:{Host:url.host,"User-Agent":"OritResearch/1.0 (+https://orit.dev; oritsoftware@gmail.com)",Accept:"text/html","Accept-Encoding":"identity"},family:4},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on("data",chunk=>{bytes+=chunk.length;if(bytes>LIMIT){req.destroy(new Error("Website body too large"));return;}chunks.push(chunk);});
      res.on("error",reject);res.on("end",()=>resolve({status:res.statusCode||0,location:res.headers.location,type:String(res.headers["content-type"]||""),html:Buffer.concat(chunks).toString("utf8")}));
    });
    const timer=setTimeout(()=>req.destroy(new Error("Website timeout")),8000);req.on("close",()=>clearTimeout(timer));req.on("error",reject);req.end();
  });
}
