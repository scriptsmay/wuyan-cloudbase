/**
 * CloudBase 全量数据导出脚本
 * 
 * 用法: node --env-file=.env scripts/export-all-data.js
 * 
 * 将所有 13 个集合导出为 JSON 文件，保存到 cheer-service/data/export/
 * 供后续 mongoimport 导入使用
 */

const cloudbase = require('@cloudbase/node-sdk');
const fs = require('fs');
const path = require('path');

const EXPORT_DIR = path.resolve(__dirname, '../../cheer-service/data/export');

// CloudBase 环境配置
const ENV_ID = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062';
const SECRET_ID = process.env.TENCENTCLOUD_SECRETID;
const SECRET_KEY = process.env.TENCENTCLOUD_SECRETKEY;

if (!SECRET_ID || !SECRET_KEY) {
  console.error('错误: 缺少 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY 环境变量');
  console.error('请在 .env 文件中配置腾讯云 API 密钥');
  process.exit(1);
}

// 13 个需要导出的集合
const COLLECTIONS = [
  'season_summaries',
  'season_snapshots',
  'match_schedules',
  'live_streams',
  'weekly_story',
  'ai_reports',
  'ask_cache',
  'checkins',
  'checkin_users',
  'checkin_daily_stats',
  'usage_limits',
  'app_config',
  'sync_snapshots',
];

async function main() {
  console.log(`CloudBase 环境: ${ENV_ID}`);
  console.log(`导出目录: ${EXPORT_DIR}\n`);

  // 初始化 CloudBase SDK
  const app = cloudbase.init({
    env: ENV_ID,
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
  });

  const db = app.database();

  // 确保导出目录存在
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  let totalDocs = 0;

  for (const collName of COLLECTIONS) {
    try {
      console.log(`[${COLLECTIONS.indexOf(collName) + 1}/${COLLECTIONS.length}] 导出 ${collName}...`);

      const collection = db.collection(collName);

      // 分页读取（CloudBase 单次最多 1000 条）
      let allDocs = [];
      let offset = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const res = await collection.skip(offset).limit(limit).get();
        const docs = res.data || [];

        if (docs.length === 0) {
          hasMore = false;
        } else {
          allDocs = allDocs.concat(docs);
          offset += limit;
          process.stdout.write(`  已读取 ${allDocs.length} 条...\r`);
        }

        // CloudBase 最多读取 5000 条（5 页）
        if (offset >= 5000) {
          console.warn(`  警告: ${collName} 可能超过 5000 条，只导出前 5000 条`);
          hasMore = false;
        }
      }

      const filePath = path.join(EXPORT_DIR, `${collName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(allDocs, null, 2), 'utf-8');
      console.log(`  ✓ 已导出 ${allDocs.length} 条 → ${collName}.json`);
      totalDocs += allDocs.length;

    } catch (err) {
      console.error(`  ✗ ${collName} 导出失败: ${err.message}`);
    }
  }

  console.log(`\n===== 导出完成 =====`);
  console.log(`总计: ${totalDocs} 条文档`);
  console.log(`文件位置: ${EXPORT_DIR}`);
  console.log(`\n下一步: 使用 mongoimport 导入到本地 MongoDB`);
  console.log(`  cd cheer-service`);
  console.log(`  bash data/export/import.sh  (或手动逐条导入)`);
}

main().catch((err) => {
  console.error('导出脚本异常:', err);
  process.exit(1);
});
