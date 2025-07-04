import fs from 'fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
const logger = console
const __dirname = dirname(fileURLToPath(import.meta.url))

import config from './config.js'
const { certNames, ossBaseUrl, sslDir, tlsConfigPath } = config

const dbPath = resolve(__dirname, 'db.json')

// 1. 读 db.json
let db = {}
try {
  const raw = await fs.readFile(dbPath, 'utf8')
  db = JSON.parse(raw)
} catch (err) {
  db = {}
}
db.certs = db.certs || {}

// 用来收集本次下载过的新 ETag
const newEtags = {}
// 本次需要部署的证书列表
const downloadedCerts = []

// 2. HEAD 检查 ETag
for (const name of certNames) {
  const urlCrt = `${ossBaseUrl}${name}.crt`
  logger.info('Checking', urlCrt)
  const headRes = await fetch(urlCrt, { method: 'HEAD' })
  if (!headRes.ok) {
    logger.error(`HEAD ${urlCrt} 返回 ${headRes.status}`)
    continue
  }
  const etag = headRes.headers.get('etag')
  if (etag && db.certs[name] === etag) {
    logger.info(name, 'ETag 未变化，跳过')
    continue
  }

  // 3. 下载 .crt 和 .key
  logger.info(name, '开始下载证书')
  const [crtRes, keyRes] = await Promise.all([
    fetch(urlCrt),
    fetch(`${ossBaseUrl}${name}.key`)
  ])
  if (!crtRes.ok || !keyRes.ok) {
    logger.error(name, '.crt 或 .key 下载失败')
    continue
  }
  const certPem = await crtRes.text()
  const keyPem = await keyRes.text()

  downloadedCerts.push({
    name,
    cert: certPem,
    key: keyPem,
  })
  if (etag) newEtags[name] = etag
}

if (downloadedCerts.length === 0) {
  logger.info('没有新的或变动的证书需要下载')
} else {
  logger.info(`准备处理 ${downloadedCerts.length} 个证书`)
}

// 4. 写文件并拼接 YAML
let yamlString = ''
for (const name of certNames) {
  logger.info('Adding cert to YAML:', { name })
  
  // 如果是本次下载的证书，需要先写入文件
  const downloadedCert = downloadedCerts.find(cert => cert.name === name)
  if (downloadedCert) {
    // 写入 ssl 目录
    await fs.writeFile(`${sslDir}${name}.crt`, downloadedCert.cert)
    await fs.writeFile(`${sslDir}${name}.key`, downloadedCert.key)
  }
  
  // 无论是否本次下载，都添加到 YAML 配置中
  yamlString +=
    `\n    - certFile: /etc/traefik/ssl/${name}.crt # ${name}\n` +
    `      keyFile: /etc/traefik/ssl/${name}.key\n`
}

// 读取并替换 _tls.yaml 中的标记
let fileContent = await fs.readFile(tlsConfigPath, 'utf8')
fileContent = fileContent.replace(
  />>>>>ohmycert-start<<<<<<([\s\S]*?)>>>>>ohmycert-end<<<<<</g,
  `>>>>>ohmycert-start<<<<<<\n${yamlString}\n#>>>>>ohmycert-end<<<<<<`
)
await fs.writeFile(tlsConfigPath, fileContent)

// 全流程结束后再写回 db.json
for (const [name, etag] of Object.entries(newEtags)) {
  db.certs[name] = etag
}
await fs.writeFile(dbPath, JSON.stringify(db, null, 2))

logger.info('所有证书更新并写回 db.json 完成')
