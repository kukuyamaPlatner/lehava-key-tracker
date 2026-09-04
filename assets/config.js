// Public config — the anon key is meant to be public (same trust model as
// the Apps Script version's "Anyone" deployment). All real access control
// lives server-side in Supabase functions (see supabase/schema.sql).
//
// Fill these in with your Supabase project's values:
// Project Settings → API → Project URL / anon public key.
window.SUPABASE_CONFIG = {
  url: 'https://kkdkaolaubphdshvqyfk.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtrZGthb2xhdWJwaGRzaHZxeWZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MDg0NDEsImV4cCI6MjEwNDA4NDQ0MX0.YxZzeI6ym3ZTpjZ1Mvcx01f2VCUczQMFT0TA-ZtqlHg',
};
