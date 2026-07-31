-- Reopen attempts that were marked Failed while SABnzbd was still
-- post-processing them. Reconcile stored the transient SABnzbd status in
-- `failure_detail`, so those rows are identifiable; a genuine failure stores
-- 'Failed' there and is left untouched. Reset to Unknown so reconcile, which
-- skips terminal attempts, can resolve them on the next poll.
UPDATE `download_attempts`
SET `status` = 'Unknown',
    `failure_detail` = NULL,
    `completed_at` = NULL
WHERE `status` = 'Failed'
  AND lower(`failure_detail`) IN (
    'queued',
    'quickcheck',
    'verifying',
    'repairing',
    'fetching',
    'extracting',
    'moving',
    'running'
  );
