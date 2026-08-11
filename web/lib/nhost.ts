import { NhostClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'localhost';
const region = process.env.NEXT_PUBLIC_NHOST_REGION || '';

export const nhost = new NhostClient({ subdomain, region });

export const GRAPHQL_HTTP = `https://${subdomain}.hasura.${region}.nhost.run/v1/graphql`;
export const GRAPHQL_WS = `wss://${subdomain}.hasura.${region}.nhost.run/v1/graphql`;
