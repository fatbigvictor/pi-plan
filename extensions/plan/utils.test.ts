/**
 * Tests for the plan-mode read-only gate.
 *
 * The two failure modes that motivated these cases:
 *   - over-blocking: `rg "code" src/` was refused because the *word* matched a blocklist
 *   - under-blocking: `ls && sed -i s/a/b/ file` was allowed because the allowlist was anchored
 *
 * Run with `npm test` (node --test, types stripped by node itself).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { explainUnsafe, exeNames, isSafeCommand, markCompletedSteps, parseCommand } from "./utils.ts";

const allowed = (command: string) => assert.equal(explainUnsafe(command), undefined, `should be allowed: ${command}`);
const blocked = (command: string, why?: RegExp) => {
	const reason = explainUnsafe(command);
	assert.notEqual(reason, undefined, `should be blocked: ${command}`);
	if (why) assert.match(reason ?? "", why);
};

test("read-only research stays allowed", () => {
	allowed("ls -la");
	allowed("ls");
	allowed("rg --files");
	allowed("find . -name '*.ts'");
	allowed("git log --oneline -5");
	allowed("git status --short");
	allowed("git diff --stat HEAD~3");
	allowed("git show HEAD:README.md");
	allowed("git rev-parse --show-toplevel");
	allowed("git -C . log --oneline -5");
	allowed("git --no-pager diff");
	allowed("git ls-files");
	allowed("git config --get user.name");
	allowed("git stash list");
	allowed("npm ls --depth=0");
	allowed("npm view react version");
	allowed("npm outdated");
	allowed("node --version");
	allowed("python -V");
	allowed("py --version");
	allowed("curl -s localhost:8000/health");
	allowed("gh pr view 12");
	allowed("gh pr list --state open");
	allowed("gh api repos/owner/repo/pulls/1");
	allowed('sqlite3 data.db "select count(*) from t"');
	allowed('awk -F"|" "{print $2}" data.txt');
	allowed("jq -r '.items[] | .name' out.json");
	allowed("sort -u names.txt");
	allowed("diff -u a.txt b.txt");
	allowed("tree -L 2");
});

test("searching for a shell-looking word is not a write", () => {
	// every one of these was blocked by the old whole-string blocklist
	allowed('rg "code" src/');
	allowed('rg -n "chmod|chown" .');
	allowed('rg "rm -rf" scripts/');
	allowed('rg "mv" .');
	allowed('grep -rn "cp " docs/');
	allowed('grep -rn "a > b" notes.md');
	allowed("cat build.log 2>&1");
	allowed("cat build.log 2>&1 | tail -20");
	allowed('rg "mkdir|touch|tee" .');
	allowed("grep -c 'su' /etc/passwd");
});

test("ordinary read-only pipelines are allowed", () => {
	allowed("cat package.json | jq .version");
	allowed("git log --oneline | head -5");
	allowed('ls -la | grep "^d"');
	allowed("rg TODO src/ | wc -l");
});

test("writes and self-repair are blocked", () => {
	blocked("rm -rf build", /not on the read-only allowlist/);
	blocked("mv a b");
	blocked("cp a b");
	blocked("mkdir out");
	blocked("touch x");
	blocked("chmod +x run.sh");
	blocked("tee out.txt");
	blocked("git commit -m x");
	blocked("git push origin main");
	blocked("git checkout main");
	blocked("git apply patch.diff");
	blocked("npm install");
	blocked("npm test");
	blocked("pytest -q");
	blocked("npx tsc --noEmit");
	blocked("node scripts/report.mjs");
	blocked("sed -i 's/a/b/' src/app.ts");
	blocked("sed -e 's/a/b/' -i.bak f");
	blocked("find . -delete");
	blocked("find . -name '*.tmp' -exec rm {} +");
	blocked("fd -x rm");
	blocked("rg --pre ./hook pattern");
	blocked("awk '{system(\"rm -rf x\")}'");
	blocked("sort -o out.txt in.txt");
	blocked("curl -o out.html https://example.com");
	blocked("wget https://example.com");
	blocked('sqlite3 data.db "delete from t"');
	blocked("gh pr create --title x");
	blocked("gh api -X POST repos/o/r/issues");
	blocked("git -c core.pager=rm log");
	blocked("git config user.name someone");
	blocked("env FOO=1 sh");
	blocked("sudo cat /etc/shadow");
});

test("shell operators cannot smuggle a write past the first token", () => {
	blocked("ls && sed -i 's/a/b/' src/app.ts");
	blocked("ls && touch pwned");
	blocked("ls; touch pwned");
	blocked('ls && node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"');
	blocked("ls && find . -delete");
	blocked("ls && python -c \"open('f','w').write('x')\"");
	blocked("ls | xargs sh -c");
});

test("redirection, substitution, and subshells are refused outright", () => {
	blocked("echo hi > out.txt", /output redirection/);
	blocked("echo hi >> out.txt", /output redirection/);
	blocked("ls $(rm -rf x)", /command substitution/);
	blocked("ls `whoami`", /command substitution/);
	blocked("diff <(ls a) <(ls b)", /process substitution/);
	blocked("cat <<EOF | sh", /heredoc/);
	blocked("( cd /tmp && ls )", /subshell/);
	blocked("echo 'unterminated", /unterminated/);
});

test("empty input is not a command", () => {
	blocked("", /empty command/);
	blocked("   ", /empty command/);
});

test("parseCommand splits segments and keeps quoted text intact", () => {
	const parsed = parseCommand(`grep "a > b" notes.md && ls -la | wc -l`);
	assert.deepEqual(parsed.segments, [
		["grep", "a > b", "notes.md"],
		["ls", "-la"],
		["wc", "-l"],
	]);
	assert.deepEqual(parsed.hazards, []);
});

test("parseCommand records hazards found outside quotes only", () => {
	assert.deepEqual(parseCommand("cat f 2>&1").hazards, []);
	assert.deepEqual(parseCommand('grep "a > b" f').hazards, []);
	assert.deepEqual(parseCommand("echo hi > f").hazards, ["output redirection"]);
	assert.deepEqual(parseCommand("ls $(whoami)").hazards, ["command substitution"]);
});

test("exeNames lists what would run, so the human can trust it", () => {
	assert.deepEqual(exeNames("npm test && npm run build"), ["npm"]);
	assert.deepEqual(exeNames("ls && sed -i s/a/b/ f"), ["ls", "sed"]);
	assert.deepEqual(exeNames('"C:/Program Files/Git/bin/bash.exe" -c ls'), ["bash"]);
	assert.deepEqual(exeNames(""), []);
});

test("isSafeCommand is the boolean form of explainUnsafe", () => {
	assert.equal(isSafeCommand("ls -la"), true);
	assert.equal(isSafeCommand("rm -rf x"), false);
});

test("markCompletedSteps only ticks steps that were reported", () => {
	const items = [
		{ step: 1, text: "one", completed: false },
		{ step: 2, text: "two", completed: false },
	];
	markCompletedSteps("did it [DONE:2]", items);
	assert.deepEqual(
		items.map((i) => i.completed),
		[false, true],
	);
});
