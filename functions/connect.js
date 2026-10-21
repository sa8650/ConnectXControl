/* Retired public relay endpoint. SMS clients now connect to EMS directly. */
export async function onRequest() {
  return new Response(JSON.stringify({
    ok: false,
    code: 'sms_dispatch_retired',
    error: 'The ConnectX relay endpoint is retired. ConnectX Android now connects directly to EMS.'
  }), {
    status: 410,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
