// Stands in for the kit's `pnpm db:migrate:ci`: runs as `migrator` (the database owner) with the
// short-lived credentials Launch handed to this run.
import postgres from 'postgres'

const sql = postgres(process.env.MIGRATOR_URL, { max: 1, onnotice: () => {} })
await sql`create table if not exists deploys (run_id text, env text, sha text, at timestamptz default now())`
await sql`insert into deploys (run_id, env, sha) values (${process.env.GITHUB_RUN_ID}, ${process.env.DEPLOY_ENV}, ${process.env.GITHUB_SHA})`
await sql`grant select on deploys to app`
console.log('migrated as', (await sql`select current_user`)[0].current_user)
await sql.end()
