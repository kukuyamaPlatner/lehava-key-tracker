// Thin wrapper around supabase-js so screen scripts just call rpc('name', {...}).
const _supabase = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

async function rpc(fn, args) {
  const { data, error } = await _supabase.rpc(fn, args || {});
  if (error) throw new Error(error.message || String(error));
  return data;
}
