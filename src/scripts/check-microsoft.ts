import { PublicClientApplication } from '@azure/msal-node';

const tenantId = process.env.MICROSOFT_TENANT_ID;
const clientId = process.env.MICROSOFT_CLIENT_ID;
if (!tenantId || !clientId) throw new Error('Set MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID. See docs/access-setup.md.');
if (!/^[a-f0-9-]{36}$/i.test(tenantId) || !/^[a-f0-9-]{36}$/i.test(clientId)) throw new Error('Tenant and client IDs must be GUIDs');
const client = new PublicClientApplication({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` } });
const result = await client.acquireTokenByDeviceCode({
  scopes: ['https://graph.microsoft.com/Files.ReadWrite'],
  deviceCodeCallback: response => console.log(response.message),
});
if (!result?.accessToken) throw new Error('Microsoft sign-in did not return a token');
const response = await fetch('https://graph.microsoft.com/v1.0/me/drive/root?$select=id', {
  headers: { Authorization: `Bearer ${result.accessToken}` },
});
if (!response.ok) throw new Error(`Graph drive check failed (HTTP ${response.status}). Ask UF IT to verify OneDrive and application consent.`);
console.log('Microsoft delegated sign-in and OneDrive read verified. No workbook was modified. Tokens are held only in memory.');
console.log('Access to the two maintained workbooks and a controlled write test still need verification once file IDs are available.');
