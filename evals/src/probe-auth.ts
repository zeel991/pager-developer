import { argaClientFromEnv } from '@pager/providers';

const client = argaClientFromEnv();
const { runId } = await client.twins.provision({
  twins: ['github'],
  ttlMinutes: 10,
  scenarioPrompt: 'A GitHub repository `acme/checkout-api` owned by org `acme`, with a pull request #377 titled "Discount codes".',
  scenarioGenerationMode: 'fast',
  public: true,
});

let status: Awaited<ReturnType<typeof client.twins.getStatus>> | undefined;
for (;;) {
  const s = await client.twins.getStatus(runId);
  if (s.status === 'ready') { status = s; break; }
  if (['failed','expired','cancelled'].includes(s.status)) { console.log('terminal', s.status); process.exit(1); }
  await new Promise((r) => setTimeout(r, 4000));
}

const gh = status!.twins.github!;
const proxy = status!.proxyToken!;
const targets = [
  { label: 'pub  ', url: gh.baseUrl },
  { label: 'admin', url: gh.adminUrl },
];
const headerSets: { name: string; headers: Record<string, string> }[] = [
  { name: 'none', headers: {} },
  { name: 'Authorization: Bearer proxy', headers: { Authorization: `Bearer ${proxy}` } },
  { name: 'X-Arga-Proxy-Token', headers: { 'X-Arga-Proxy-Token': proxy } },
  { name: 'X-Proxy-Token', headers: { 'X-Proxy-Token': proxy } },
  { name: 'x-arga-token', headers: { 'x-arga-token': proxy } },
  { name: 'proxy hdr + gh bearer', headers: { 'X-Arga-Proxy-Token': proxy, Authorization: 'Bearer ghp_x' } },
];

for (const t of targets) {
  for (const h of headerSets) {
    for (const path of ['/repos/acme/checkout-api/commits', '/user']) {
      try {
        const res = await fetch(`${t.url}${path}`, { headers: h.headers });
        const body = (await res.text()).slice(0, 70).replace(/\s+/g, ' ');
        console.log(`${t.label} ${path.padEnd(34)} ${h.name.padEnd(28)} -> ${res.status} ${body}`);
      } catch (e) {
        console.log(`${t.label} ${path} ${h.name} -> ERR ${(e as Error).message.slice(0, 40)}`);
      }
    }
  }
}
