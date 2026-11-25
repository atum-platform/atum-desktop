"""Native MCP SDK machine credentials; no interactive login or token scheduler."""
import time


def build_client_credentials_provider(server_url, config, storage):
    from mcp.client.auth.extensions.client_credentials import ClientCredentialsOAuthProvider

    config = dict(config)
    if not config.get('client_id') or not config.get('client_secret'):
        from tools.mcp_oauth import _read_json
        cached = _read_json(storage._client_info_path()) or {}
        for key in ('client_id', 'client_secret'):
            config.setdefault(key, cached.get(key))
    if not all(isinstance(config.get(key), str) and config[key]
               and not config[key].startswith('${') for key in ('client_id', 'client_secret')):
        raise ValueError('mcp_client_credentials_required')
    method = config.get('token_endpoint_auth_method', 'client_secret_post')
    if method not in ('client_secret_post', 'client_secret_basic'):
        raise ValueError('mcp_client_credentials_auth_method_invalid')

    class Provider(ClientCredentialsOAuthProvider):
        async def _initialize(self):
            await super()._initialize()
            # Hermes storage rebases absolute expiry on load. SDK's machine
            # provider loads tokens but does not seed the context expiry.
            tokens = self.context.current_tokens
            if tokens is not None and tokens.expires_in is not None:
                self.context.token_expiry_time = time.time() + tokens.expires_in - 1

    return Provider(server_url=server_url, storage=storage,
                    client_id=config['client_id'], client_secret=config['client_secret'],
                    token_endpoint_auth_method=method, scope=config.get('scope'),
                    issuer=config.get('issuer') or server_url.rsplit('/mcp', 1)[0])
