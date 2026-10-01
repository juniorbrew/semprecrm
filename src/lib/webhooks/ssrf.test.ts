import { describe, it, expect, vi } from 'vitest';
import { DestinoNaoPermitido, fetchSeguro, isPrivateOrReservedIp, isDeliverableUrl, lookupVetado, requestFixado } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});

// SempreCRM: IPv6 que carrega IPv4 — o parser de URL reescreve em hexadecimal
// (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), e a versão original deixava passar.
describe('isPrivateOrReservedIp — IPv4 embutido em IPv6', () => {
  it.each([
    '::ffff:7f00:1', // 127.0.0.1 mapeado (forma que o URL produz)
    '::ffff:a9fe:a9fe', // 169.254.169.254 mapeado
    '::ffff:127.0.0.1',
    '::7f00:1', // compatível
    '64:ff9b::a9fe:a9fe', // NAT64 → metadata
    'ff02::1', // multicast
    '0:0:0:0:0:ffff:0a00:0001', // 10.0.0.1 por extenso
  ])('%s é interno', (ip) => expect(isPrivateOrReservedIp(ip)).toBe(true));

  it.each(['2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808'])('%s é público', (ip) =>
    expect(isPrivateOrReservedIp(ip)).toBe(false),
  );

  it('a URL com o loopback mapeado é recusada', async () => {
    expect(await isDeliverableUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(await isDeliverableUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toBe(false);
  });

  it('esquema que não é http(s) é recusado', async () => {
    expect(await isDeliverableUrl('file:///etc/passwd')).toBe(false);
    expect(await isDeliverableUrl('gopher://8.8.8.8/')).toBe(false);
  });

  it('IPv4 reservado que faltava (multicast, broadcast, 198.18/15)', () => {
    for (const ip of ['224.0.0.1', '255.255.255.255', '198.18.0.1', '240.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });
});

describe('fetchSeguro', () => {
  it('segue o redirect público e recusa o que rebate para dentro', async () => {
    const chamadas: string[] = [];
    const respostas: Record<string, Response> = {
      'https://1.1.1.1/a': new Response(null, { status: 301, headers: { location: 'https://1.0.0.1/b' } }),
      'https://1.0.0.1/b': new Response('ok', { status: 200 }),
      'https://8.8.8.8/x': new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? 'GET'} ${url} ${init?.redirect}`);
      return respostas[url];
    }));
    const ok = await fetchSeguro('https://1.1.1.1/a', { method: 'POST', body: '{}' });
    expect(ok.status).toBe(200);
    // 301 vira GET sem corpo, e o runtime nunca segue sozinho.
    expect(chamadas).toEqual(['POST https://1.1.1.1/a manual', 'GET https://1.0.0.1/b manual']);

    await expect(fetchSeguro('https://8.8.8.8/x')).rejects.toBeInstanceOf(DestinoNaoPermitido);
    expect(chamadas.at(-1)).toBe('GET https://8.8.8.8/x manual');
    vi.unstubAllGlobals();
  });

  it('recusa destino interno sem chamar o fetch', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(fetchSeguro('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(DestinoNaoPermitido);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('fetchSeguro — segredo não atravessa para outra origem', () => {
  it('mesma origem mantém os cabeçalhos; outra origem leva só content-type/accept', async () => {
    const vistos: Array<Record<string, string>> = [];
    const respostas: Record<string, Response> = {
      'https://1.1.1.1/a': new Response(null, { status: 307, headers: { location: '/b' } }),
      'https://1.1.1.1/b': new Response(null, { status: 307, headers: { location: 'https://8.8.8.8/c' } }),
      'https://8.8.8.8/c': new Response('ok', { status: 200 }),
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      vistos.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return respostas[url];
    }));
    const hdrs = { 'content-type': 'application/json', authorization: 'Bearer segredo', 'x-api-key': 'k' };
    await fetchSeguro('https://1.1.1.1/a', { method: 'POST', headers: hdrs, body: '{}' });
    expect(vistos[1]).toMatchObject({ authorization: 'Bearer segredo', 'x-api-key': 'k' });
    expect(vistos[2]).toEqual({ 'content-type': 'application/json' });
    vi.unstubAllGlobals();
  });
});

describe('DNS rebinding — o IP conferido é o IP conectado', () => {
  const pub = { address: '93.184.216.34', family: 4 };
  const priv = { address: '127.0.0.1', family: 4 };

  it('lookupVetado entrega só endereços públicos e recusa se houver um interno', async () => {
    const chama = (addrs: { address: string; family: number }[], all: boolean) =>
      new Promise<unknown[]>((resolve) =>
        lookupVetado(async () => addrs)('h.example', { all }, (...args: unknown[]) => resolve(args)),
      );
    expect(await chama([pub], false)).toEqual([null, pub.address, 4]);
    expect(await chama([pub], true)).toEqual([null, [pub]]);
    const [err] = await chama([pub, priv], false);
    expect(err).toBeInstanceOf(DestinoNaoPermitido);
  });

  it('público na conferência e privado na conexão: recusa sem conectar', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    let n = 0;
    const resolver = vi.fn(async () => (n++ === 0 ? [pub] : [priv]));
    await expect(
      fetchSeguro('http://rebind.example/hook', { method: 'POST', body: '{}' }, 3, resolver),
    ).rejects.toBeInstanceOf(DestinoNaoPermitido);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('requestFixado conecta pelo lookup dado e devolve uma Response', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let corpo = '';
      req.on('data', (c) => (corpo += c));
      req.on('end', () => {
        res.writeHead(201, { 'x-eco': req.headers['x-k'] as string });
        res.end(`${req.method} ${req.url} ${corpo}`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const usado: string[] = [];
    const res = await requestFixado(
      `http://qualquer.example:${port}/p?q=1`,
      { method: 'POST', headers: { 'x-k': 'v' }, body: 'oi' },
      (host, opts, cb) => {
        usado.push(host);
        if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
        else cb(null, '127.0.0.1', 4);
      },
    );
    expect(usado).toEqual(['qualquer.example']);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-eco')).toBe('v');
    expect(await res.text()).toBe('POST /p?q=1 oi');
    await new Promise((r) => server.close(r));
  });
});

describe('requestFixado — respostas hostis', () => {
  const loopback: Parameters<typeof requestFixado>[2] = (_h, opts, cb) => {
    if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  async function servidorBruto(resposta: string | null, onReq?: (raw: string) => void) {
    const net = await import('node:net');
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        onReq?.(d.toString());
        if (resposta !== null) sock.write(resposta);
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://h.example:${port}/`, close: () => new Promise((r) => server.close(r)) };
  }

  it('status 999 rejeita (não fica pendurado)', async () => {
    const s = await servidorBruto('HTTP/1.1 999 Weird\r\nContent-Length: 0\r\n\r\n');
    await expect(requestFixado(s.url, {}, loopback)).rejects.toThrow(/invalid HTTP status 999/);
    await s.close();
  });

  it('101 Switching Protocols rejeita e fecha o socket', async () => {
    const s = await servidorBruto('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await expect(
      requestFixado(s.url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } }, loopback),
    ).rejects.toThrow(/upgrade refused/);
    await s.close();
  });

  it('abort rejeita mesmo se o servidor nunca responde', async () => {
    const s = await servidorBruto(null);
    const ctrl = new AbortController();
    const p = requestFixado(s.url, { signal: ctrl.signal }, loopback);
    setTimeout(() => ctrl.abort(new Error('timeout')), 30);
    await expect(p).rejects.toThrow(/timeout/);
    await s.close();
  });

  it('envia User-Agent padrão e descarta Host/Transfer-Encoding/Content-Length da conta', async () => {
    let raw = '';
    const s = await servidorBruto('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', (r) => (raw += r));
    const res = await requestFixado(
      s.url,
      { method: 'POST', body: 'oi', headers: { host: 'evil.internal', 'transfer-encoding': 'chunked', 'content-length': '999' } },
      loopback,
    );
    expect(res.status).toBe(200);
    expect(raw).toMatch(/user-agent: SempreCRM-Webhook\/1\.0/i);
    expect(raw).not.toMatch(/evil\.internal/);
    expect(raw).not.toMatch(/content-length: 999/i);
    expect(raw).not.toMatch(/transfer-encoding: chunked/i);
    await s.close();
  });
});
