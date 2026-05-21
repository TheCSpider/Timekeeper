'use strict';

const cron = require('node-cron');
const { getTimezone } = require('./weekly');
const { generateWeeklyReport, generateMonthlyReport } = require('./reports');

// Note: the cron timezone is locked to whatever is in app_settings at startup.
// The report DATA will always use the current timezone from app_settings at
// run time, so the content is always correct. Only the firing moment is fixed.
async function initScheduler() {
  const tz = await getTimezone();

  // Sunday 00:00 in configured timezone
  cron.schedule('0 0 * * 0', async () => {
    console.log('📊 Running weekly report...');
    await generateWeeklyReport();
  }, { timezone: tz });

  // 1st of month 00:00 in configured timezone
  cron.schedule('0 0 1 * *', async () => {
    console.log('📊 Running monthly report...');
    await generateMonthlyReport();
  }, { timezone: tz });

  console.log(`✅ Scheduler initialized (timezone: ${tz})`);
}

module.exports = { initScheduler };
