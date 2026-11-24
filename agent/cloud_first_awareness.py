"""Cloud-first v1 retrieval at the native MemoryProvider transport seam.

Both ports have the same fixed account/audience binding. This adapter grants no
credentials, writes, or fallback authority. Local privacy must still be current.
"""
from agent.atum_awareness_contract import validate_retrieval_response


class CloudFirstAwareness:
    def __init__(self, cloud, local, *, fallback_current):
        self._cloud = cloud
        self._local = local
        self.fallback_current = fallback_current
        self.historical_local = False

    def __call__(self, request, cancelled):
        self.historical_local = False
        try:
            result = validate_retrieval_response(self._cloud(request, cancelled), request)
        except (ConnectionError, TimeoutError):
            result = None
        # Denial, malformed response, empty success, Off/Forget and cancellation
        # never authorize historical evidence. No broad exception-as-outage.
        outage = result is None or (result['status'] == 'unavailable'
            and set(result['errors']) <= {'service_unavailable', 'index_unavailable', 'timeout'})
        if outage and not cancelled.is_set() and self.fallback_current() is True:
            result = validate_retrieval_response(self._local(request, cancelled), request)
            self.historical_local = result['status'] != 'unavailable'
        return result
