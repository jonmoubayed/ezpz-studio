import assert from 'node:assert/strict'
import {configPayload,extractionFields,normalizeRun} from '../src/api'
import {defaultConfig} from '../src/domain'
const nested={line_items:[{description:'Consulting',amount:250}],approved:false}
const fields=extractionFields({result:{fields:{empty:{value:null,confidence:0},structured:{value:nested,confidence:.9},cited:{value:10,confidence:.99,evidence:[{page:2,bbox:[20,40,60,80]}]}}},parser_ir:{pages:[{page:2,width:200,height:400}]}})
assert.equal(fields[0].value,null)
assert.deepEqual(fields[1].value,nested)
assert.ok(fields.every(f=>f.expected===null),'Unknown ground truth is not inferred from actual output')
assert.deepEqual(fields[2].area,{left:10,top:10,width:20,height:10})
assert.equal(fields[2].page,2)
assert.equal(extractionFields({result:{fields:{total:{value:1}}}},{value:{total:0}})[0].expected,0)
assert.equal(normalizeRun({id:'test',created_at:'2026-09-04',metrics:{field_accuracy:0},status:'completed'}).score,0)
assert.equal(normalizeRun({id:'test',created_at:'2026-09-04'}).score,null)
assert.equal(configPayload(defaultConfig).prompt.extraction,defaultConfig.prompt)
assert.equal(configPayload({...defaultConfig,provider:'openai-compatible',baseUrl:'http://localhost:8080/v1'}).model.base_url,'http://localhost:8080/v1')
assert.throws(()=>configPayload({...defaultConfig,schema:'invalid'}))
console.log('PASS: structured values, nulls, absent ground truth, zero scores/ground truth, citation coordinates, provider-neutral config, and invalid JSON.')
