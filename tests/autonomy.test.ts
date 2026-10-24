import test from "node:test";
import assert from "node:assert/strict";
import { exaCompanies } from "../src/lib/outreach/exa";
import { SupabaseStore } from "../src/lib/outreach/store";
import { verifyNextCandidate } from "../src/lib/outreach/prospects";
import { IntakeSchema } from "../src/lib/outreach/intake";

test("Exa credentials go only to its fixed API and search links cannot bypass business verification",async()=>{
  const previous=process.env.EXA_API_KEY;process.env.EXA_API_KEY="test-private-key";
  try {
    const request:typeof fetch=async(url,options)=>{
      assert.equal(url,"https://api.exa.ai/search");assert.equal(options?.redirect,"error");
      assert.equal(new Headers(options?.headers).get("x-api-key"),"test-private-key");
      const body=JSON.parse(String(options?.body));assert.equal(body.type,"auto");assert.equal(body.category,undefined);assert.equal(body.numResults,20);assert.ok(body.excludeDomains.includes("known.com"));
      return Response.json({results:[{title:"A shop",url:"https://shopbrand.com/products/cup?ref=search"},{title:"duplicate",url:"https://www.shopbrand.com/contact"},{url:"https://known.com"},{url:"https://amazon.com/shop"},{title:"Provider profile",url:"https://exa.ai/library/organization/123"},{url:"https://127.0.0.1"},{url:"http://insecure.com"},{url:"https://user:password@other.com"},{url:"https://secondbrand.com/"}]});
    };
    assert.deepEqual(await exaCompanies("US ecommerce",["known.com"],1,request),[{name:"A shop",website:"https://shopbrand.com/",domain:"shopbrand.com"},{name:"secondbrand.com",website:"https://secondbrand.com/",domain:"secondbrand.com"}]);
    await assert.rejects(()=>exaCompanies("US ecommerce",[],0,async()=>new Response("Do not log this private provider error",{status:429})),error=>error instanceof Error && error.message==="Exa company search failed" && (error as Error & {status:number}).status===429);
    await assert.rejects(()=>exaCompanies("US ecommerce",[],0,async()=>Response.json({results:"invalid"})));
  }finally{if(previous===undefined)delete process.env.EXA_API_KEY;else process.env.EXA_API_KEY=previous;}
});

test("temporary storefront failures retry up to three attempts while unsuitable companies are skipped",async()=>{
  const outcomes:string[]=[];
  let attempt=1;
  const db={candidate:async()=>({id:42,website:"https://brand.com/",attempts:attempt}),addLead:async()=>true,finishCandidate:async(_id:number,status:string)=>{outcomes.push(status);}};
  const verify=async()=>{throw new Error("temporary timeout");};
  assert.equal((await verifyNextCandidate({db,verify})).retryScheduled,true);
  attempt=3;assert.equal((await verifyNextCandidate({db,verify})).retryScheduled,false);
  await verifyNextCandidate({db,verify:async()=>null});assert.deepEqual(outcomes,["retry","retry","skipped"]);
});

test("reply storage preserves bounded content, extracted data and the contacted company without duplicate rows",async()=>{
  let saved:Record<string,unknown>={};
  const fake={from(table:string){
    if(table==="outreach_leads")return {select(){return {eq(field:string,value:string){assert.equal(field,"email");assert.equal(value,"hello@brand.com");return {maybeSingle:async()=>({data:{id:12},error:null})};}};}};
    assert.equal(table,"outreach_intakes");return {upsert:async(value:Record<string,unknown>,options:Record<string,unknown>)=>{saved=value;assert.equal(options.ignoreDuplicates,true);assert.equal(options.onConflict,"message_key");return {error:null};}};
  }};
  const store=new SupabaseStore(fake as unknown as ConstructorParameters<typeof SupabaseStore>[0]);
  const analysis=IntakeSchema.parse({category:"product_submission",summary:"Product brief",product_name:"Cup",product_description:"A reusable cup",product_url:"https://brand.com/products/cup",target_audience:"Commuters",research_question:"Which lid design is preferred?",order_reference:null,missing_information:[],next_action:"research_intake"});
  await store.saveIntake({key:"gmail:123",sender:"HELLO@brand.com",subject:"Product brief",text:"a".repeat(25000),receivedAt:new Date().toISOString(),attachmentNames:Array.from({length:60},()=>"brief.pdf")},analysis);
  assert.equal(String(saved.body_text).length,20000);assert.equal(saved.body_incomplete,true);assert.equal(saved.lead_id,12);assert.deepEqual(saved.analysis,{...analysis,_sender_authenticated:false});assert.equal((saved.attachment_names as string[]).length,50);
});
