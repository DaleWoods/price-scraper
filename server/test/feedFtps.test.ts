import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import FtpSrv from 'ftp-srv';

/**
 * The feed server presents a self-signed certificate. These prove the
 * password is only ever sent to the certificate that was approved: not when
 * none has been approved (the fingerprint is reported instead), and not when
 * a different certificate turns up.
 *
 * A real FTPS server with its own self-signed certificate is started for the
 * purpose. Needs the openssl command to make the certificate.
 */
let haveOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  haveOpenssl = false;
}

describe('FTPS with a self-signed certificate', { skip: !haveOpenssl && 'openssl not installed' }, () => {
  let server: FtpSrv;
  let folder = '';
  let fingerprint = '';
  let logins = 0;
  let feedSource: typeof import('../src/import/feedSource.ts');

  before(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'ftps-test-'));
    const keyPath = path.join(folder, 'key.pem');
    const certPath = path.join(folder, 'cert.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=feeds.test'],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(certPath);
    fingerprint = new X509Certificate(cert).fingerprint256;

    const root = path.join(folder, 'files');
    execFileSync('mkdir', ['-p', root]);
    writeFileSync(path.join(root, 'PRODGoldsmithsExportGoogleFeed.tsv'), 'id\tprice\n1\t10.00 GBP\n');

    server = new FtpSrv({
      url: 'ftp://127.0.0.1:0',
      pasv_url: '127.0.0.1',
      anonymous: false,
      tls: { key: readFileSync(keyPath), cert },
    });
    server.on('login', ({ username, password }, resolve, reject) => {
      logins += 1;
      if (username === 'tester' && password === 'secret') resolve({ root });
      else reject(new Error('bad login'));
    });
    await server.listen();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;

    process.env.FEED_FTP_PROTOCOL = 'ftps';
    process.env.FEED_FTP_HOST = '127.0.0.1';
    process.env.FEED_FTP_PORT = String(port);
    process.env.FEED_FTP_USER = 'tester';
    process.env.FEED_FTP_PASSWORD = 'secret';
    process.env.FEED_FTP_DIRECTORY = '/';
    feedSource = await import('../src/import/feedSource.ts');
  });

  after(async () => {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('stops before logging in, and reports the fingerprint, when none is approved', async () => {
    delete process.env.FEED_FTP_TLS_FINGERPRINT;
    logins = 0;
    await assert.rejects(feedSource.listFeedDirectory(), (err: Error) => {
      assert.ok(err instanceof feedSource.FeedCertificateError);
      assert.ok(err.message.includes(fingerprint), 'the message must show the fingerprint to approve');
      return true;
    });
    assert.equal(logins, 0, 'the password must not have been sent');
  });

  it('refuses a certificate other than the approved one', async () => {
    process.env.FEED_FTP_TLS_FINGERPRINT = 'AA:'.repeat(31) + 'AA';
    logins = 0;
    await assert.rejects(feedSource.listFeedDirectory(), /different certificate/);
    assert.equal(logins, 0);
  });

  it('logs in and lists the feeds once the certificate is approved, however the fingerprint is written', async () => {
    process.env.FEED_FTP_TLS_FINGERPRINT = fingerprint.replace(/:/g, '').toLowerCase();
    const files = await feedSource.listFeedDirectory();
    assert.deepEqual(files.map((file) => file.name), ['PRODGoldsmithsExportGoogleFeed.tsv']);
  });
});
