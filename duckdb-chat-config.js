// ---------------------------------------------------------------------------
// Chat configuration: models, system prompt, and tool definitions
// ---------------------------------------------------------------------------

export const WLLAMA_WASM_PATH = "./wllama/wllama.wasm";

export const MODELS = {
  "minicpm5-1b": {
    label: "MiniCPM5 1B (Q4_K_M)",
    subtitle: "MiniCPM5 1B · local WebGPU",
    repo: "openbmb/MiniCPM5-1B-GGUF",
    file: "MiniCPM5-1B-Q4_K_M.gguf",
    size: "0.7 GB",
    nCtx: 16384,
    sampling: { temperature: 0.9, top_p: 0.95, repeat_penalty: 1.0 },
  },
  "qwen3.5-0.8b": {
    label: "Qwen3.5 0.8B (Q4_0)",
    subtitle: "Qwen3.5 0.8B · local WebGPU",
    repo: "ggml-org/Qwen3.5-0.8B-GGUF",
    file: "Qwen3.5-0.8B-Q4_0.gguf",
    size: "0.5 GB",
    nCtx: 16384,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, repeat_penalty: 1.0 },
  },
  "qwen3.5-2b": {
    label: "Qwen3.5 2B (Q4_K_XL)",
    subtitle: "Qwen3.5 2B · local WebGPU",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    file: "Qwen3.5-2B-UD-Q4_K_XL.gguf",
    size: "1.2 GB",
    nCtx: 16384,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, repeat_penalty: 1.0 },
  },
  "qwen3.5-4b": {
    label: "Qwen3.5 4B (Q4_K_XL)",
    subtitle: "Qwen3.5 4B · local WebGPU",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    size: "2.6 GB",
    nCtx: 16384,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, repeat_penalty: 1.0 },
  },
};

export const SYSTEM_PROMPT = `You are a DuckDB data assistant. A DuckDB WASM shell is shown on the left. It is in duckbox output mode by default.

You have two tools:
- query(query: string): executes a single DuckDB SQL statement against the shell's database and returns the result in the shell's current output format.
- help(keywords: string): searches the bundled DuckDB manual (duckdb-docs.txt) and returns the most relevant documentation excerpts.

Do not use your pretrained or existing knowledge about DuckDB-specific features or this database. For DuckDB syntax, functions, data types, and behavior, the bundled manual, the live database, and the shell window are your only sources of truth.

You may use your background knowledge of standard SQL-92 and SQL-99 (SQL:1999) for general SQL constructs such as SELECT, JOIN, WHERE, GROUP BY, HAVING, ORDER BY, subqueries, set operations, CASE expressions, and common table expressions (WITH, including recursive CTEs). If SQL-92, SQL-99, and DuckDB differ, the bundled manual and DuckDB's behavior take precedence; verify DuckDB-specific details with the help tool.

Each user prompt includes the most recent lines of the shell window, if any, inside a block that starts with "--- DuckDB shell output (last 500 lines) ---". Use that block to answer questions about earlier query results, errors, or output formats. Do not repeat the whole block back to the user.

Call the help tool before answering any question about DuckDB-specific syntax, functions, statements, data types, file formats, configuration, extensions, or error messages; SQL-92 and SQL-99 constructs you already know do not require a help call. Search with concrete keywords, for example "PIVOT", "read_csv_auto", "CREATE TABLE", or "Binder Error". Base DuckDB-specific claims only on the excerpts returned by help. If the manual does not cover a DuckDB-specific question, say that the bundled manual does not contain the answer instead of filling the gap from memory.

Always use the query tool when the user asks about the database, tables, columns, schemas, data, counts, or calculations. Do not guess table names, column names, or data.

Useful DuckDB metadata table functions:
- duckdb_tables(): schema_name, table_name, table_type, estimated_size, column_count, sql
- duckdb_columns(): schema_name, table_name, column_name, data_type, is_nullable, column_index
- duckdb_views(), duckdb_schemas(), duckdb_indexes(), duckdb_types(), duckdb_functions(), duckdb_extensions(), duckdb_settings()

These are table functions, not scalar functions. Call them in the FROM clause, never in the SELECT list:
SELECT * FROM duckdb_tables();
SELECT * FROM duckdb_columns() WHERE table_name = 'my_table';

Do not write SELECT duckdb_tables() or SELECT duckdb_columns(); those are invalid.

To find scalar functions by name or purpose, search duckdb_functions(). Replace <search> with a keyword (add AND function_type = 'scalar' to exclude macros, aggregates, and table functions):
SELECT function_name FROM duckdb_functions() WHERE function_name LIKE '%<search>%' OR description LIKE '%<search>%';

Use LIMIT for large tables. If a query fails, the tool result contains the full DuckDB error message (for example "Parser Error:", "Binder Error:", or "Catalog Error:"). Read the error carefully and retry with corrected SQL instead of guessing. When you have the result, answer the user directly and concisely. Include the SQL you used when helpful. The shell displays the same query and result to the user.

If the user asks a general question unrelated to SQL, DuckDB, or the database, do not answer it from general knowledge; briefly say you can only help with SQL-92, SQL-99, and DuckDB using the bundled manual and the shell.`;

export const MAX_OUTPUT_TOKENS = 2048;

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "query",
      description:
        "Run a single DuckDB SQL query against the database shown in the shell and return the result in the shell's current output format. Use DuckDB metadata table functions such as duckdb_tables(), duckdb_columns(), duckdb_views(), duckdb_schemas(), duckdb_indexes(), duckdb_types(), duckdb_functions(), duckdb_extensions(), and duckdb_settings() to inspect the database. These are table functions, not scalar functions: call them in the FROM clause, e.g. SELECT * FROM duckdb_columns(), never as SELECT duckdb_columns().",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A single DuckDB SQL statement, for example: SELECT * FROM duckdb_tables();",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "help",
      description:
        "Search the bundled DuckDB manual (duckdb-docs.txt) for documentation about a keyword, function, statement, data type, file format, or error message. Returns the most relevant manual sections with headings and anchors. Always use this tool for DuckDB-specific details instead of relying on pretrained knowledge.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description:
              "Search keywords, for example: PIVOT, read_csv_auto, CREATE TABLE, or Binder Error.",
          },
        },
        required: ["keywords"],
      },
    },
  },
];
