/**
 * Seed provider registry — the hand-maintained layer that models.dev can't
 * encode: which wire protocol a provider speaks and which auth flow it needs.
 *
 * Ported from raw-ai-providers-for-onboarding/providers.seed.ts. models.dev
 * supplies the model universe at runtime; this seed supplies wire + auth.
 * Anything missing falls back to { wire: 'openai-chat', auth: 'api-key' }.
 */
import type { ProviderAuth, ProviderGroup, ProviderWire, SeedProvider } from './types'

export const PROVIDER_GROUPS: { id: ProviderGroup; label: string }[] = [
  { id: 'frontier', label: 'Frontier labs' },
  { id: 'enterprise', label: 'Enterprise clouds' },
  { id: 'gateway', label: 'Gateways & aggregators' },
  { id: 'gpu', label: 'Fast inference / GPU clouds' },
  { id: 'labs', label: 'Model labs' },
  { id: 'github', label: 'GitHub' },
  { id: 'local', label: 'Local & self-hosted' },
  { id: 'custom', label: 'Custom & misc' }
]

export const SEED_PROVIDERS: SeedProvider[] = [
  // ---- A. Frontier labs ----
  { id: 'openai', name: 'OpenAI', wire: 'openai', auth: 'api-key', group: 'frontier', baseURL: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'] },
  { id: 'anthropic', name: 'Anthropic', wire: 'anthropic', auth: 'api-key', group: 'frontier', baseURL: 'https://api.anthropic.com', env: ['ANTHROPIC_API_KEY'] },
  { id: 'google', name: 'Google Gemini', wire: 'google', auth: 'api-key', group: 'frontier', env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
  { id: 'xai', name: 'xAI Grok', wire: 'openai-chat', auth: 'api-key', group: 'frontier', baseURL: 'https://api.x.ai/v1', env: ['XAI_API_KEY'] },
  { id: 'mistral', name: 'Mistral', wire: 'openai-chat', auth: 'api-key', group: 'frontier', baseURL: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'] },
  { id: 'cohere', name: 'Cohere', wire: 'openai-chat', auth: 'api-key', group: 'frontier', baseURL: 'https://api.cohere.ai', env: ['COHERE_API_KEY'] },
  { id: 'deepseek', name: 'DeepSeek', wire: 'openai-chat', auth: 'api-key', group: 'frontier', baseURL: 'https://api.deepseek.com', env: ['DEEPSEEK_API_KEY'] },

  // ---- B. Enterprise clouds ----
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', wire: 'bedrock', auth: 'aws-sigv4', group: 'enterprise', env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] },
  { id: 'google-vertex', name: 'Google Vertex AI', wire: 'google', auth: 'gcp-adc', group: 'enterprise', env: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'], notes: 'vertex/anthropic models use the anthropic wire' },
  { id: 'azure', name: 'Azure OpenAI', wire: 'azure', auth: 'azure-ad', group: 'enterprise', env: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'] },
  { id: 'sap-ai-core', name: 'SAP AI Core', wire: 'openai-chat', auth: 'oauth', group: 'enterprise' },
  { id: 'snowflake-cortex', name: 'Snowflake Cortex', wire: 'openai-chat', auth: 'oauth', group: 'enterprise' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', wire: 'openai-chat', auth: 'api-key', group: 'enterprise', env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
  { id: 'gitlab', name: 'GitLab Duo', wire: 'openai-chat', auth: 'api-key', group: 'enterprise', env: ['GITLAB_TOKEN'] },

  // ---- C. Aggregators / gateways ----
  { id: 'openrouter', name: 'OpenRouter', wire: 'openai-chat', auth: 'api-key', group: 'gateway', baseURL: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'], notes: 'OpenAI-compatible — paste an API key from openrouter.ai/keys.' },
  { id: 'vercel', name: 'Vercel AI Gateway', wire: 'openai-chat', auth: 'api-key', group: 'gateway', baseURL: 'https://ai-gateway.vercel.sh/v1', env: ['AI_GATEWAY_API_KEY'] },
  { id: 'gateway', name: 'AI Gateway', wire: 'openai-chat', auth: 'api-key', group: 'gateway' },
  { id: 'llmgateway', name: 'LLM Gateway', wire: 'openai-chat', auth: 'api-key', group: 'gateway', baseURL: 'https://api.llmgateway.io/v1', env: ['LLMGATEWAY_API_KEY'] },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', wire: 'openai-chat', auth: 'api-key', group: 'gateway', env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
  { id: 'zenmux', name: 'ZenMux', wire: 'openai-chat', auth: 'api-key', group: 'gateway', env: ['ZENMUX_API_KEY'] },
  { id: 'kilo', name: 'Kilo Code', wire: 'openai-chat', auth: 'oauth', group: 'gateway' },
  { id: 'opencode', name: 'opencode zen', wire: 'openai-chat', auth: 'oauth', group: 'gateway' },
  { id: 'requesty', name: 'Requesty', wire: 'openai-chat', auth: 'api-key', group: 'gateway', baseURL: 'https://router.requesty.ai/v1', env: ['REQUESTY_API_KEY'] },

  // ---- D. Fast-inference / GPU clouds ----
  { id: 'groq', name: 'Groq', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'] },
  { id: 'cerebras', name: 'Cerebras', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.cerebras.ai/v1', env: ['CEREBRAS_API_KEY'] },
  { id: 'togetherai', name: 'Together AI', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'] },
  { id: 'deepinfra', name: 'DeepInfra', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.deepinfra.com/v1/openai', env: ['DEEPINFRA_API_KEY'] },
  { id: 'nvidia', name: 'NVIDIA NIM', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://integrate.api.nvidia.com/v1', env: ['NVIDIA_API_KEY'] },
  { id: 'perplexity', name: 'Perplexity', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.perplexity.ai', env: ['PERPLEXITY_API_KEY'] },
  { id: 'venice', name: 'Venice AI', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.venice.ai/api/v1', env: ['VENICE_API_KEY'] },
  { id: 'fireworks', name: 'Fireworks AI', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.fireworks.ai/inference/v1', env: ['FIREWORKS_API_KEY'] },
  { id: 'hyperbolic', name: 'Hyperbolic', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.hyperbolic.xyz/v1', env: ['HYPERBOLIC_API_KEY'] },
  { id: 'sambanova', name: 'SambaNova', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.sambanova.ai/v1', env: ['SAMBANOVA_API_KEY'] },
  { id: 'novita', name: 'Novita AI', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.novita.ai/v3/openai', env: ['NOVITA_API_KEY'] },
  { id: 'lambda', name: 'Lambda', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://api.lambda.ai/v1', env: ['LAMBDA_API_KEY'] },
  { id: 'baseten', name: 'Baseten', wire: 'openai-chat', auth: 'api-key', group: 'gpu', baseURL: 'https://inference.baseten.co/v1', env: ['BASETEN_API_KEY'] },

  // ---- E. Model labs ----
  { id: 'alibaba', name: 'Alibaba Qwen (DashScope)', wire: 'openai-chat', auth: 'api-key', group: 'labs', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: ['DASHSCOPE_API_KEY'] },
  { id: 'moonshotai', name: 'Moonshot Kimi', wire: 'openai-chat', auth: 'api-key', group: 'labs', baseURL: 'https://api.moonshot.ai/v1', env: ['MOONSHOT_API_KEY'] },
  { id: 'zhipuai', name: 'Zhipu GLM', wire: 'openai-chat', auth: 'api-key', group: 'labs', baseURL: 'https://open.bigmodel.cn/api/paas/v4', env: ['ZHIPUAI_API_KEY'] },
  { id: 'minimax', name: 'MiniMax', wire: 'openai-chat', auth: 'api-key', group: 'labs', baseURL: 'https://api.minimax.chat/v1', env: ['MINIMAX_API_KEY'] },
  { id: 'stepfun', name: 'StepFun', wire: 'openai-chat', auth: 'api-key', group: 'labs', baseURL: 'https://api.stepfun.com/v1', env: ['STEPFUN_API_KEY'] },

  // ---- F. GitHub ----
  { id: 'github-copilot', name: 'GitHub Copilot', wire: 'openai-chat', auth: 'device-flow', group: 'github', responsesForGpt5: true, notes: 'OAuth device flow then short-lived Copilot token. Requires a Copilot subscription.' },
  { id: 'github-models', name: 'GitHub Models', wire: 'openai-chat', auth: 'api-key', group: 'github', baseURL: 'https://models.github.ai/inference', env: ['GITHUB_TOKEN'], notes: 'GitHub PAT with models:read.' },

  // ---- G. Local / self-hosted ----
  { id: 'ollama', name: 'Ollama', wire: 'openai-chat', auth: 'none', group: 'local', baseURL: 'http://localhost:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio', wire: 'openai-chat', auth: 'none', group: 'local', baseURL: 'http://localhost:1234/v1' },
  { id: 'vllm', name: 'vLLM', wire: 'openai-chat', auth: 'none', group: 'local', baseURL: 'http://localhost:8000/v1' },
  { id: 'llamacpp', name: 'llama.cpp', wire: 'openai-chat', auth: 'none', group: 'local', baseURL: 'http://localhost:8080/v1' },

  // ---- H. Catch-all ----
  { id: 'openai-compatible', name: 'OpenAI-compatible (custom)', wire: 'openai-chat', auth: 'api-key', group: 'custom', notes: 'Supply a base URL + key for any OpenAI-shaped endpoint.' },
  { id: 'huggingface', name: 'Hugging Face', wire: 'openai-chat', auth: 'api-key', group: 'custom', baseURL: 'https://router.huggingface.co/v1', env: ['HF_TOKEN'] }
]

/** Providers surfaced prominently at the top of onboarding. */
export const FEATURED_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'github-copilot',
  'ollama',
  'openai-compatible'
]

export const DEFAULT_SEED: SeedProvider = {
  id: 'openai-compatible',
  name: 'Unknown (OpenAI-compatible)',
  wire: 'openai-chat',
  auth: 'api-key',
  group: 'custom'
}

const SEED_BY_ID = new Map(SEED_PROVIDERS.map((p) => [p.id, p]))

export function resolveSeed(providerId: string): SeedProvider {
  return SEED_BY_ID.get(providerId) ?? { ...DEFAULT_SEED, id: providerId, name: providerId }
}

/** Human-readable label for an auth method. */
export const AUTH_LABELS: Record<ProviderAuth, string> = {
  'api-key': 'API key',
  oauth: 'OAuth sign-in',
  'device-flow': 'Device flow',
  'aws-sigv4': 'AWS credentials',
  'gcp-adc': 'Google credentials',
  'azure-ad': 'Azure / Entra ID',
  none: 'No auth (local)'
}

/** Wire protocols we can drive today; others are connectable but not yet callable. */
const SUPPORTED_WIRES: ProviderWire[] = ['openai-chat', 'openai', 'anthropic', 'google']

/** Whether onboarding can fully connect this provider now (api-key / none only). */
export function isConnectableNow(seed: SeedProvider): boolean {
  return (seed.auth === 'api-key' || seed.auth === 'none') && SUPPORTED_WIRES.includes(seed.wire)
}
