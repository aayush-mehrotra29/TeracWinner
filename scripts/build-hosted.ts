import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
async function main() {
  const packageJson=JSON.parse(readFileSync("package.json","utf8"));
  const directory="supabase/functions/orit-outreach";mkdirSync(directory,{recursive:true});
  writeFileSync(`${directory}/index.ts`,'import { hostedHandler } from "./worker.js";\nDeno.serve(hostedHandler);\n');
  writeFileSync(`${directory}/deno.json`,JSON.stringify({nodeModulesDir:"auto",compilerOptions:{lib:["deno.ns","dom","esnext"]}},null,2)+"\n");
  await build({entryPoints:["src/lib/outreach/hosted-handler.ts"],outfile:`${directory}/worker.js`,bundle:true,format:"esm",platform:"node",target:"es2022",inject:[resolve("scripts/edge-globals.ts")],
    plugins:[{name:"deno-npm",setup(builder){builder.onResolve({filter:/^(?:@supabase\/supabase-js|html-to-text|imapflow|mailparser|nodemailer|openai|tldts|zod)(?:\/|$)/},args=>{
      const parts=args.path.split("/");const name=args.path.startsWith("@")?parts.slice(0,2).join("/"):parts[0];
      const suffix=args.path.slice(name.length);const version=packageJson.dependencies[name].replace(/^[^\d]*/,"");return {path:`npm:${name}@${version}${suffix}`,external:true};
    });}}]});
  console.log("Built Supabase worker; runtime credentials are not bundled.");
}
main().catch(()=>{console.error("Hosted worker build failed");process.exitCode=1;});
