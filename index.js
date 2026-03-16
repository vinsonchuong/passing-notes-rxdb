export function serveRxdb({persistence, path = ''}) {
  const urlPattern = new URLPattern({
    pathname: path ? `${path}/:collection` : '/:collection',
  })

  return (next) => async (request) => {
    const url = new URL(request.url, 'http://localhost')

    const match = urlPattern.exec(url)
    if (!match) {
      return next(request)
    }

    const collectionName = match.pathname.groups.collection

    if (!persistence.schemas[collectionName]) {
      return next(request)
    }

    if (
      request.method === 'GET' &&
      request.headers.accept === 'text/event-stream'
    ) {
      let unsubscribe

      const body = new ReadableStream({
        start(controller) {
          // Initial heartbeat
          controller.enqueue(
            `data: ${JSON.stringify({documents: [], checkpoint: null})}\n\n`,
          )

          unsubscribe = persistence.subscribe(collectionName, (payload) => {
            controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`)
          })
        },
        cancel() {
          if (unsubscribe) {
            unsubscribe()
          }
        },
      })

      return {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
        body,
      }
    }

    if (request.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const updatedAt = Number(url.searchParams.get('updatedAt') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 20)

      const {documents, checkpoint} = persistence.pull(collectionName, {
        updatedAt,
        id,
        pageSize: limit,
      })

      return {
        status: 200,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({documents, checkpoint}),
      }
    }

    if (request.method === 'POST') {
      const items = JSON.parse(request.body)
      const conflicts = persistence.push(collectionName, items)

      return {
        status: 200,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(conflicts),
      }
    }

    return next(request)
  }
}
