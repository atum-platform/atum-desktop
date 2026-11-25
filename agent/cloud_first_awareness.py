"""Cloud-first v1/v2 retrieval at the native MemoryProvider transport seam.

Both ports have the same fixed account/audience binding. This adapter grants no
credentials, writes, or fallback authority. Local privacy must still be current.
"""
import httpx

from agent.atum_awareness_contract import validate_retrieval_response


class CloudFirstAwareness:
    def __init__(self, cloud, local=None, *, fallback_current=lambda: False, version=1):
        if version not in (1, 2):
            raise ValueError("awareness_contract_invalid")
        self.version = version
        self._cloud = cloud
        self._local = local
        self.fallback_current = fallback_current

    def __call__(self, request, cancelled):
        if self.version == 2:
            from agent.atum_awareness_v2 import validate_response, unavailable
        else:
            validate_response = validate_retrieval_response
            unavailable = lambda req: {"requestId": req["requestId"], "audience": req["audience"],
                "status": "unavailable", "items": [], "coverage": [],
                "contentBytes": 0, "errors": ["service_unavailable"]}
        try:
            result = validate_response(self._cloud(request, cancelled), request)
        except (ConnectionError, TimeoutError, httpx.TransportError):
            result = unavailable(request)
        # Denial, malformed response, empty success, Off/Forget and cancellation
        # never authorize historical evidence. No broad exception-as-outage.
        outage = (result['status'] == 'unavailable'
            and set(result['errors']) <= {'service_unavailable', 'index_unavailable', 'timeout'})
        if outage and self._local is not None and not cancelled.is_set() and self.fallback_current() is True:
            result = validate_response(self._local(request, cancelled), request)
            if cancelled.is_set() or self.fallback_current() is not True:
                return {**unavailable(request), "retrievalOrigin": "cloud"}
            return {**result, 'retrievalOrigin': 'local_historical_fallback'}
        return {**result, 'retrievalOrigin': 'cloud'}
