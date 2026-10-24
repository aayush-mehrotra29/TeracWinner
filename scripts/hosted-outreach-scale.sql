-- Operational configuration for the existing hosted agent; no schema changes.
-- Apply after the base migrations. Runtime credentials remain in Vault.
select public.orit_configure('{"OUTREACH_DAILY_LIMIT":"20","OUTREACH_FOCUS":"independent US ecommerce brands selling physical consumer products across home goods, apparel, accessories, skincare, reusable products and pet products"}'::jsonb);
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'orit-email-discover'), schedule := '17 */2 * * *');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'orit-email-verify'), schedule := '4-59/5 * * * *');
