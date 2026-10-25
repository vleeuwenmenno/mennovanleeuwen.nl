// Checks the Agents app's pretty model names and makers (src/data/agentModelNames.ts) against the
// ids Ollama Cloud and OpenAI give, the search over them, and the thinking effort a thread gets.
//
//   node scripts/agents-model-names.ts
//
// Exits 1 on any failure.

import { check, finish } from './empires-harness.ts'
import { effortFor, modelMatch, modelName, type Effort, type MakerId } from '../src/data/agentModelNames.ts'

type ModelInfo = { name: string; thinking: boolean; vision: boolean; contextLength: number | null; provider?: string; efforts?: Effort[] }
const effectiveEffort = (m: ModelInfo, picked: Effort | null, mode: 'quick' | 'deep') => effortFor(m.efforts, picked, mode)

const CASES: [string, string, string | null, MakerId, string?][] = [
  ['beam', 'beam', null, 'other'],
  ['deepseek-v4-pro:0813', 'DeepSeek V4 Pro', '0813', 'deepseek'],
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', null, 'deepseek'],
  ['deepseek-v4.1-flash:1017', 'DeepSeek V4.1 Flash', '1017', 'deepseek'],
  ['gemma4:31b', 'Gemma 4', '31B', 'google'],
  ['glm-5.2', 'GLM 5.2', null, 'zai'],
  ['glm-5.3', 'GLM 5.3', null, 'zai'],
  ['glm-5.3-flash', 'GLM 5.3 Flash', null, 'zai'],
  ['gpt-oss:120b', 'GPT-OSS', '120B', 'openai'],
  ['kimi-k2.6', 'Kimi K2.6', null, 'moonshot'],
  ['minimax-m3', 'MiniMax M3', null, 'minimax'],
  ['mistral-large-3:675b', 'Mistral Large 3', '675B', 'mistral'],
  ['nemotron-3-super', 'Nemotron 3 Super', null, 'nvidia'],
  ['qwen3-coder:480b', 'Qwen3 Coder', '480B', 'alibaba'],
  ['llama3.3:70b', 'Llama 3.3', '70B', 'meta'],
  ['devstral-2:123b', 'Devstral 2', '123B', 'mistral'],
  ['chatgpt/gpt-5.5', 'GPT-5.5', null, 'openai', 'GPT-5.5'],
  ['chatgpt/gpt-6-astra', 'GPT-6-Astra', null, 'openai', 'GPT-6-Astra'],
  ['openai/gpt-4o-mini', 'GPT-4o Mini', null, 'openai'],
  ['openai/o4-mini', 'o4 Mini', null, 'openai'],
  ['some-new-model:latest', 'some-new-model', null, 'other'],
]

for (const [raw, name, variant, maker, label] of CASES) {
  const n = modelName(raw, label)
  check(`${raw} → ${name}${variant ? ` [${variant}]` : ''} by ${maker} (got ${n.name}${n.variant ? ` [${n.variant}]` : ''} by ${n.maker})`, n.name === name && n.variant === variant && n.maker === maker && n.raw === raw)
}
check('providers come from the prefix', modelName('chatgpt/gpt-5.5').provider === 'chatgpt' && modelName('openai/gpt-4o').provider === 'openai' && modelName('glm-5.3').provider === 'ollama')

// Search: pretty name, raw id, maker and provider; in order with gaps; no match is 0.
const ds = modelName('deepseek-v4.1-flash:1017')
check('search by pretty words', modelMatch(ds, 'deepseek flash') > 0)
check('search by raw id', modelMatch(ds, 'v4.1-flash:1017') > 0)
check('search by gaps', modelMatch(ds, 'dsv41') > 0)
check('search by maker', modelMatch(modelName('kimi-k2.6'), 'moonshot') > 0)
check('search by provider', modelMatch(modelName('chatgpt/gpt-5.5', 'GPT-5.5'), 'chatgpt') > 0)
check('no match is 0', modelMatch(ds, 'mistral') === 0)
check('a tighter gap match ranks first', modelMatch(ds, 'dsv41') > modelMatch(modelName('deepseek-v4-pro:0813'), 'dsv41'))
check('a run scores above gaps', modelMatch(ds, 'flash') > modelMatch(ds, 'fsh'))

// Effort: the mode's when none is picked; the nearest the model has otherwise.
const gpt: ModelInfo = { name: 'chatgpt/gpt-5.5', thinking: true, vision: true, contextLength: 272000, provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh'] }
const glm: ModelInfo = { name: 'glm-5.3', thinking: true, vision: false, contextLength: 200000, provider: 'ollama', efforts: ['off', 'on'] }
const oss: ModelInfo = { name: 'gpt-oss:120b', thinking: true, vision: false, contextLength: 131072, provider: 'ollama', efforts: ['low', 'medium', 'high'] }
const plain: ModelInfo = { name: 'beam', thinking: false, vision: false, contextLength: null }
check('quick is low, deep is high', effectiveEffort(gpt, null, 'quick') === 'low' && effectiveEffort(gpt, null, 'deep') === 'high')
check('Ollama on/off models think by default in both modes', effectiveEffort(glm, null, 'quick') === 'on' && effectiveEffort(glm, null, 'deep') === 'on')
check('gpt-oss follows the mode', effectiveEffort(oss, null, 'quick') === 'low' && effectiveEffort(oss, null, 'deep') === 'high')
check('a picked level stays', effectiveEffort(gpt, 'xhigh', 'quick') === 'xhigh')
check('a level the model lacks goes to the nearest', effectiveEffort(gpt, 'minimal', 'quick') === 'low' && effectiveEffort(oss, 'xhigh', 'quick') === 'high')
check('off on a model without off is its lowest', effectiveEffort(gpt, 'off', 'quick') === 'low')
check('a level on an on/off model is on', effectiveEffort(glm, 'high', 'quick') === 'on')
check('no effort for a model that cannot think', effectiveEffort(plain, 'high', 'quick') === null)

finish()
