import test from "node:test";
import assert from "node:assert/strict";
import { commerceEvidence, productLinks } from "../src/lib/outreach/commerce";
import { hostedHandler } from "../src/lib/outreach/hosted-handler";
import type { PublicPage } from "../src/lib/outreach/public-web";

test("ecommerce prospects require a purchase control and a priced product",()=>{
  const page:PublicPage={url:"https://brand.com/products/cup",text:"Reusable Cup $24.00 Add to cart",html:'<form action="/cart/add"><button name="add">Add to cart</button></form>'};
  assert.ok(commerceEvidence(page));
  assert.equal(commerceEvidence({...page,text:"Cart subtotal $0.00 Add to cart"}),null);
  assert.equal(commerceEvidence({...page,html:'<input type="hidden" value="Add to cart">'}),null);
  assert.equal(commerceEvidence({...page,text:"Our ecommerce consulting services start at $24",html:'<a href="/contact">Contact us</a>'}),null);
  assert.equal(commerceEvidence({...page,text:"Cup $24 Sold out",html:'<button disabled>Add to cart</button>'}),null);
  const json='<script type="application/ld+json">{"@type":"Product","name":"Cup","offers":{"price":"24","priceCurrency":"USD"}}</script><form action="/cart/add"><button>Add to cart</button></form>';
  assert.ok(commerceEvidence({...page,text:"Cup Add to cart",html:json}));
});
test("only same-business product URLs are queued for ecommerce verification",()=>{
  const page:PublicPage={url:"https://brand.com/",text:"Shop",html:'<a href="/products/cup?variant=2">Cup</a><a href="/product/bottle">Bottle</a><a href="https://other.com/products/socks">Other</a><a href="/contact">Contact</a>'};
  assert.deepEqual(productLinks(page),["https://brand.com/products/cup","https://brand.com/product/bottle"]);
});
test("hosted endpoint rejects unauthenticated requests before database access",async()=>{
  assert.equal((await hostedHandler(new Request("https://worker.example",{method:"GET"}))).status,405);
  assert.equal((await hostedHandler(new Request("https://worker.example",{method:"POST",body:'{"action":"outbound"}'}))).status,401);
  assert.equal((await hostedHandler(new Request("https://worker.example",{method:"POST",headers:{Authorization:"Bearer short"},body:'{"action":"configure"}'}))).status,401);
});

test("bounded HTTP parser handles chunked product pages and rejects malformed bodies",async()=>{
  const {decodeHttpResponse}=await import("../src/lib/outreach/pinned-http");
  const result=decodeHttpResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"));
  assert.equal(result.html,"hello");assert.equal(result.status,200);
  assert.throws(()=>decodeHttpResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4000000\r\n\r\nx")),/too large/);
  assert.throws(()=>decodeHttpResponse(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nGG\r\nhello\r\n")),/chunk/);
  assert.throws(()=>decodeHttpResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nx")),/compressed/);
});
test("hosted network pins the public IP and verifies TLS using the business hostname",async()=>{
  const {pinnedHttps}=await import("../src/lib/outreach/pinned-http");
  const global=globalThis as unknown as {Deno?:unknown};const previous=global.Deno;
  const response=Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");let offset=0;
  let written="";let pinned=false;let verified=false;
  const connection={read:async(buffer:Uint8Array)=>{if(offset>=response.length)return null;const data=response.subarray(offset,offset+buffer.length);buffer.set(data);offset+=data.length;return data.length;},write:async(buffer:Uint8Array)=>{written+=new TextDecoder().decode(buffer);return buffer.length;},close:()=>{}};
  global.Deno={connect:async(options:{hostname:string;port:number})=>{assert.equal(options.hostname,"8.8.8.8");assert.equal(options.port,443);pinned=true;return connection;},startTls:async(socket:unknown,options:{hostname:string})=>{assert.equal(socket,connection);assert.equal(options.hostname,"brand.com");verified=true;return connection;}};
  try{assert.equal((await pinnedHttps(new URL("https://brand.com/products/cup"),"8.8.8.8")).html,"hello");assert.equal(pinned,true);assert.equal(verified,true);assert.match(written,/Host: brand.com/);assert.match(written,/GET \/products\/cup HTTP\/1.1/);}
  finally{if(previous===undefined)delete global.Deno;else global.Deno=previous;}
});

test("discovery excludes already assessed storefronts as well as contacted businesses",async()=>{
  const {SupabaseStore}=await import("../src/lib/outreach/store");
  const fixtures:Record<string,{domain:string}[]>={outreach_leads:[{domain:"sent.example"},{domain:"shared.example"}],outreach_candidates:[{domain:"skipped.example"},{domain:"pending.example"},{domain:"shared.example"}]};
  const fake={from(table:string){return {select(){return {order(){return {limit:async()=>({data:fixtures[table],error:null})};}};}};}};
  const store=new SupabaseStore(fake as unknown as ConstructorParameters<typeof SupabaseStore>[0]);
  assert.deepEqual((await store.domains()).sort(),["pending.example","sent.example","shared.example","skipped.example"]);
});
