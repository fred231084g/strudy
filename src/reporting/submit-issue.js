/* Submits issue reports merged in the repository as issue on the relevant repo
   and documents the said GitHub issue in the issue report.
   Can also be called on a specific issue report (typicall when it gets merged in)
 */

const path = require("path");
const fs = require("fs").promises;
const matter = require('gray-matter');
const { execSync } = require('child_process');
const Octokit = require("../lib/octokit");

const GH_TOKEN = (() => {
  try {
    return require("../config.json").GH_TOKEN;
  } catch (err) {
    return process.env.GH_TOKEN;
  }
})();

const octokit = new Octokit({
  auth: GH_TOKEN,
  //log: console
});


if (require.main === module) {
  const targetIssueReport = process.argv[2];
  let issuesToSubmit = [];
  (async function() {
    if (targetIssueReport) {
      try {
	if ((await fs.stat(targetIssueReport)).isFile()) {
	  issuesToSubmit.push(targetIssueReport);
	} else {
	  console.error(`${targetIssueReport} is not a file`);
	  process.exit(2);
	}
      } catch (err) {
	console.error(`${targetIssueReport} does not exist`);
	process.exit(2);
    }
    } else {
      issuesToSubmit = (await fs.readdir('issues')).filter(p => p.endsWith('.md'));
    }
    let needsCommit = false;
    for (let filename of issuesToSubmit) {
      const issueReport = await fs.readFile(filename, "utf-8");
      const issueData  = matter(issueReport);
      const {data: metadata, content: body} = issueData;
      if (!(metadata?.Repo && metadata?.Tracked && metadata?.Title && body)) {
	console.error(`Could not parsed expected data from ${filename}.`, JSON.stringify(issueData, null, 2));
	continue;
      }
      if (metadata.Tracked !== "N/A") {
	console.log(`Issue report ${filename} already filed as ${metadata.Tracked}.`);
	continue;
      }
      const m = metadata.Repo.match(/https:\/\/github\.com\/([^\/]*)\/([^\/]*)\/?$/);
      if (!m) {
	console.error(`Cannot parse ${metadata.Repo} as a github repository url.`);
	continue;
      }
      const [,owner, repo] = m;
      const ghRes = await octokit.rest.issues.create({
	owner,
	repo,
	title: metadata.Title,
	body
      });
      const issueUrl = ghRes?.data?.url || "42";
      if (issueUrl) {
	metadata.Tracked = issueUrl;
	fs.writeFile(filename, issueData.stringify(), 'utf-8');
	execSync(`git add -u ${filename}`);
	needsCommit = true;
      }
    }
    if (needsCommit) {
      execSync(`git commit -m "Update issue reports with github issue ref"`);
      execSync(`git push origin main`);
    }
  })();
}
