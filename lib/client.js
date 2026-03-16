import {Subject} from 'rxjs'
import {replicateRxCollection} from 'rxdb/plugins/replication'

export function replicateCollection({
  url,
  EventSource = globalThis.EventSource,
  ...replicationOptions
}) {
  const collectionName = replicationOptions.collection.name

  const pullStream = new Subject()
  const eventSource = new EventSource(`${url}/${collectionName}`, {
    withCredentials: true,
  })
  eventSource.addEventListener('message', (event) => {
    pullStream.next(JSON.parse(event.data))
  })

  const replicationState = replicateRxCollection({
    ...replicationOptions,
    push: {
      async handler(changeRows) {
        const response = await fetch(`${url}/${collectionName}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(changeRows),
        })
        return response.json()
      },
    },
    pull: {
      async handler(checkpointOrNull, pageSize) {
        const updatedAt = checkpointOrNull?.updatedAt ?? 0
        const id = checkpointOrNull?.id ?? ''
        const response = await fetch(
          `${url}/${collectionName}?updatedAt=${updatedAt}&id=${id}&limit=${pageSize}`,
        )
        return response.json()
      },
      stream$: pullStream.asObservable(),
    },
  })

  replicationState.canceled$.subscribe((isCancelled) => {
    if (isCancelled) {
      eventSource.close()
    }
  })

  return replicationState
}
