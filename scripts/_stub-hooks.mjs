// scripts/_stub-hooks.mjs — module resolution hooks for the API tests.
//
// Redirects @supabase/supabase-js to the in-memory stub so a handler can be
// imported unmodified. Doing it here rather than by dropping a fake package into
// node_modules means `npm install` cannot quietly restore the real client
// underneath a test and turn it into a live network call — which is exactly what
// happened once.
export async function resolve(specifier, context, next){
  if(specifier === '@supabase/supabase-js'){
    return { shortCircuit: true, url: new URL('./_supabase-stub.mjs', import.meta.url).href };
  }
  return next(specifier, context);
}
