#!/usr/bin/env node
'use strict';
require('dotenv').config();

const { collectDataHealth, repairOwnerMemberships, recoverMissingLocalSources } = require('../services/dataHealth');

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--repair-memberships')) {
    const count = await repairOwnerMemberships();
    console.log(`Owner memberships repaired: ${count}`);
  }
  if (args.has('--recover-sources')) {
    const result = await recoverMissingLocalSources({ dryRun: args.has('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
  }

  const health = await collectDataHealth();
  console.log(JSON.stringify({
    project_count: health.projects.length,
    source_count: health.sources.length,
    local_source_file_count: health.localSourceFiles.length,
    unmatched_source_files: health.sourceFilesWithoutRows.map(f => f.file_url),
    unmatched_export_files: health.exportsWithoutDocuments.map(f => f.file_url),
    orphaned_projects: health.orphanedProjects.map(p => ({ id: p.id, name: p.name })),
    missing_owner_memberships: health.missingOwnerMemberships.map(p => ({ id: p.id, name: p.name })),
    entity_rows_missing_source: health.entityRowsMissingSource,
  }, null, 2));
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
