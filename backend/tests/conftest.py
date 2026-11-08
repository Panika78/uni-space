import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://uni_space:test-password@localhost:5432/uni_space_test",
)
