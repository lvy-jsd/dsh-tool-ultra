import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRouting } from '../../scripts/evaluate-routing.mjs'

const tools = [
  { name: 'read', description: 'read file content', tokens: 100 },
  { name: 'weather', description: 'weather forecast rain temperature', tokens: 80 },
]
test('offline evaluation reports selection evidence without model calls or tool execution', async () => {
  const report = await evaluateRouting(tools, [
    { id: 'file', query: 'read file', expected: ['read'] },
    { id: 'weather', query: 'forecast rain', expected: ['weather'] },
    { id: 'none', query: 'zzzzunmatched', expected: [] },
  ], 1)
  assert.equal(report.meanExpectedRecallAtK, 1)
  assert.equal(report.allSchemasTokensEstimated, 180)
  assert.equal(report.meanSelectedSchemaTokensEstimated, 60)
  assert.equal(report.rows[2].correctAbstention, true)
  assert.equal(report.modelCalls, 0)
  assert.equal(report.toolExecutions, 0)
  assert.ok(!JSON.stringify(report).includes('zzzzunmatched'), 'does not echo private intents')
})
test('evaluation refuses unknown labels and invalid limits instead of inflating scores', async () => {
  await assert.rejects(evaluateRouting(tools, [{ id: 'missing', query: 'x', expected: ['absent'] }]), /absent/)
  await assert.rejects(evaluateRouting(tools, [{ id: 'x', query: 'x', expected: [] }], 0), /limit/)
})
