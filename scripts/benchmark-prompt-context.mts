import { writeFile } from "node:fs/promises";
import { budgetUntrustedPromptContext, promptContextCodePoints } from "../services/ts/messaging-worker/src/prompt-context-budget.js";

const fixture = {
  messages: Array.from({length:30},(_,index)=>({role:"user" as const,text:`Fictional message ${String(index)}: ${"פרטי שירות 😀 ".repeat(90)}`})),
  knowledge: Array.from({length:40},(_,index)=>({sourceId:"synthetic-source",documentId:`synthetic-document-${String(index)}`,version:1,factKey:`price_${String(index)}`,value:`Approved price ₪1234.56 ${"synthetic detail ".repeat(45)}`})),
  retrievedDocumentContext:Array.from({length:8},(_,index)=>({documentId:`synthetic-document-${String(index)}`,content:"Synthetic context ".repeat(55)})),
  customerSessionMemory:{content:"Synthetic memory ".repeat(470)},
};
const after=budgetUntrustedPromptContext(fixture);
const report={measuredAt:new Date().toISOString(),node:process.version,synthetic:true,
  before:{codePoints:promptContextCodePoints(fixture),bytes:Buffer.byteLength(JSON.stringify(fixture))},
  after:{codePoints:promptContextCodePoints(after),bytes:Buffer.byteLength(JSON.stringify(after)),messages:after.messages?.length,facts:after.knowledge?.length,truncation:after.contextTruncation},
  numericFactsUnchanged:(after.knowledge ?? []).every(fact=>JSON.stringify(fact)===JSON.stringify(fixture.knowledge.find(original=>original.factKey===fact.factKey))),
  limitations:["Direct aggregate context function benchmark, not actual integrated provider request.","Different retained context sets; no model quality, latency, billing or semantic parity claim.","Budget measures Unicode codepoints of untrusted JSON, not tokens and not authority/system/schema/receipts."]};
await writeFile(process.argv[2] ?? "../evidence/prompt-context-size-local.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
