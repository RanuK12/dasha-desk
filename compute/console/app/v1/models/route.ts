const headers = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=60",
};

export async function GET() {
  return Response.json(
    {
      object: "list",
      data: [
        { id: "qwen3-8b", object: "model", created: 0, owned_by: "community", context_length: 32768, status: "source-ready", size_gb: 5.2, min_memory_gb: 8 },
        { id: "gemma3-12b", object: "model", created: 0, owned_by: "community", context_length: 131072, status: "source-ready", size_gb: 8.1, min_memory_gb: 16 },
        { id: "gpt-oss-20b", object: "model", created: 0, owned_by: "community", context_length: 131072, status: "source-ready", size_gb: 14, min_memory_gb: 16 },
        { id: "qwen3-30b-a3b", object: "model", created: 0, owned_by: "community", context_length: 32768, status: "source-ready", size_gb: 19, min_memory_gb: 24 },
        { id: "gemma3-27b", object: "model", created: 0, owned_by: "community", context_length: 131072, status: "source-ready", size_gb: 17, min_memory_gb: 24 },
        { id: "gpt-oss-120b", object: "model", created: 0, owned_by: "community", context_length: 131072, status: "source-ready", size_gb: 65, min_memory_gb: 96 },
      ],
    },
    { headers },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}
