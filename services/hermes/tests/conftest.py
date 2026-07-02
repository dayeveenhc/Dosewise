import os

# Must be set before hermes.config builds its cached Settings.
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret-at-least-32-characters-long")
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:54321")
os.environ.setdefault("SUPABASE_ANON_KEY", "anon-test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-test")
