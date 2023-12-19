// Import only necessary modules and functions
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { completion } from 'litellm';
import { ensureIsLogged } from '@/lib/api/ensureAppIsLogged';
import { edgeWrapper } from '@/lib/api/edgeHelpers';
import Handlebars from 'handlebars';

export const runtime = 'edge';

// Consider moving these arrays to an external configuration or loading them dynamically
const OPENROUTER_MODELS = ['mistralai/mistral-7b-instruct', /* other models */];
const ANTHROPIC_MODELS = ['claude-2', 'claude-2.0', 'claude-instant-v1'];

// Simplify the convertInputToOpenAIMessages function
const convertInputToOpenAIMessages = (input) => {
  return input.map(({ role, content, text, functionCall, toolCalls, name }) => ({
    role: role.replace('ai', 'assistant'),
    content: content || text,
    function_call: functionCall,
    tool_calls: toolCalls,
    name,
  }));
};

// Streamline the substractPlayAllowance function
const substractPlayAllowance = async (session, supabase) => {
  const { data: profile, error } = await supabase
    .from('profile')
    .select('id, org(id, play_allowance)')
    .match({ id: session.user.id })
    .single();

  if (error) throw error;
  if (profile.org?.play_allowance <= 0) {
    throw new Error('No allowance left today. Upgrade to continue using the playground.');
  }

  await supabase
    .from('org')
    .update({ play_allowance: profile.org.play_allowance - 1 })
    .eq('id', profile.org.id);
};

export default edgeWrapper(async function handler(req) {
  const { session, supabase } = await ensureIsLogged(req);

  await substractPlayAllowance(session, supabase);

  const { content, extra, testValues } = await req.json();
  let copy = [...content];

  // Handle templating more efficiently
  if (testValues) {
    copy = copy.map(item => {
      const template = Handlebars.compile(item.content);
      return { ...item, content: template(testValues) };
    });
  }

  const model = extra?.model || 'gpt-3.5-turbo';
  const messages = convertInputToOpenAIMessages(copy);

  let method;
  // Optimize model selection and API setup
  if (ANTHROPIC_MODELS.includes(model)) {
    method = completion;
  } else {
    const openAIparams = OPENROUTER_MODELS.includes(model)
      ? { apiKey: process.env.OPENROUTER_API_KEY, /* other params */ }
      : { apiKey: process.env.OPENAI_API_KEY };

    const openai = new OpenAI(openAIparams);
    method = openai.chat.completions.create.bind(openai.chat.completions);
  }

  // Streamline API call
  const response = await method({
    model, messages,
    temperature: extra?.temperature,
    max_tokens: extra?.max_tokens,
    /* other parameters */
  });

  const stream = OpenAIStream(response);
  return new StreamingTextResponse(stream);
});
