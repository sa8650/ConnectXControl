/* Public Connect App endpoint: https://<connectx>/connect
   Products and the Android app (URL hidden in the app backend) both use this. */
import { handleConnect } from './_lib/connect.js';
import { failResponse } from './_lib/connect_protocol.js';

export async function onRequest(context) {
  try {
    if (!context.env?.DB) return failResponse('ConnectX database is not configured.', 503, 'not_ready');
    return await handleConnect(context.request, context.env);
  } catch (error) {
    console.error('ConnectX connect', error);
    return failResponse('Connect App could not complete that request.', 500, 'internal');
  }
}
