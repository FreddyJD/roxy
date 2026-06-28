/**
 * Copy the provider brand logos we use from @lobehub/icons-static-svg into the
 * repo at src/renderer/src/assets/providers/<providerId>.svg, so the icons are
 * committed and bundled (not resolved from node_modules at runtime).
 *
 * Run: npm run icons:providers
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'node_modules', '@lobehub', 'icons-static-svg', 'icons')
const OUT = join(root, 'src', 'renderer', 'src', 'assets', 'providers')

/** seed provider id -> lobehub static svg filename */
const MAP = {
  openai: 'openai.svg',
  anthropic: 'claude-color.svg',
  google: 'gemini-color.svg',
  xai: 'grok.svg',
  mistral: 'mistral-color.svg',
  cohere: 'cohere-color.svg',
  deepseek: 'deepseek-color.svg',
  'amazon-bedrock': 'bedrock-color.svg',
  'google-vertex': 'vertexai-color.svg',
  azure: 'azure-color.svg',
  'snowflake-cortex': 'snowflake-color.svg',
  'cloudflare-workers-ai': 'cloudflare-color.svg',
  'cloudflare-ai-gateway': 'cloudflare-color.svg',
  openrouter: 'openrouter.svg',
  vercel: 'vercel.svg',
  groq: 'groq.svg',
  cerebras: 'cerebras-color.svg',
  togetherai: 'together-color.svg',
  deepinfra: 'deepinfra-color.svg',
  nvidia: 'nvidia-color.svg',
  perplexity: 'perplexity-color.svg',
  venice: 'venice-color.svg',
  fireworks: 'fireworks-color.svg',
  hyperbolic: 'hyperbolic-color.svg',
  sambanova: 'sambanova-color.svg',
  novita: 'novita-color.svg',
  alibaba: 'qwen-color.svg',
  moonshotai: 'kimi-color.svg',
  zhipuai: 'zhipu-color.svg',
  minimax: 'minimax-color.svg',
  stepfun: 'stepfun-color.svg',
  'github-copilot': 'copilot-color.svg',
  'github-models': 'github.svg',
  ollama: 'ollama.svg',
  lmstudio: 'lmstudio.svg',
  vllm: 'vllm-color.svg',
  huggingface: 'huggingface-color.svg'
}

mkdirSync(OUT, { recursive: true })
let copied = 0
const missing = []
for (const [id, file] of Object.entries(MAP)) {
  const src = join(SRC, file)
  if (existsSync(src)) {
    copyFileSync(src, join(OUT, `${id}.svg`))
    copied++
  } else {
    missing.push(file)
  }
}

console.log(`✓ Copied ${copied} provider logos to assets/providers/`)
if (missing.length) console.warn('Missing source files:', missing.join(', '))
