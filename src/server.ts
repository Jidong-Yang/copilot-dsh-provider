export interface Provider {
  health: (signal?: AbortSignal) => Promise<object>
  models: (signal?: AbortSignal) => Promise<object>
  response: (payload: unknown, signal?: AbortSignal) => Promise<Response>
}

export function createServer(client: Provider): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(await client.health(request.signal))
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        return Response.json(await client.models(request.signal))
      } catch (error) {
        return errorResponse(error)
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      try {
        const upstream = await client.response(await request.json(), request.signal)
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        })
      } catch (error) {
        return errorResponse(error)
      }
    }
    return Response.json({ error: { message: "Not found", type: "not_found" } }, {
      status: 404,
    })
  }
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: { message, type: "provider_error" } }, {
    status: 502,
  })
}
