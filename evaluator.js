const _ = require('lodash');
const GitHub = require('github');
const flatten = require('flat');
const fs = require('fs');
require('console.table');
// Token can be generated at https://github.com/settings/tokens
const argv = require('minimist')(process.argv.slice(2));
//  sort: 'updated', order: 'desc'
let opt = {
	export: argv.e || 'data_latest',
	import: argv.i,
	query: argv.q,
	limit: argv.l || 100,
	sort: argv.s || 'updated',
	order: argv.o || 'desc',
};

if (!opt.import && !opt.query) {
	throw new Error('Query[-q] is not provided');
}

/**
 *
 * @type {Bluebird}
 */
const Promise = require('bluebird');  // npm install bluebird

const github = new GitHub({
	debug: false,
	Promise: Promise
});

github.authenticate({
	type: 'token',
	token: getToken(),
});

class Scrapper {

	/**
	 *
	 * @param {Github} api
	 */
	constructor(api) {
		this.api = api;
	}

	test(owner, repo) {
		return this.api.repos.getContributors({owner, repo});
	}

	/**
	 * Views not possible
	 * @param owner
	 * @param repo
	 * @return {Promise<any>}
	 */
	fetch(owner, repo, idx = 0) {
		const repoId = {owner, repo};
		return this.api.repos.get(repoId).then(({data, meta}) => {
			console.log('fetching idx', idx, data.full_name, 'Limit:', meta['x-ratelimit-remaining']);
			const {
				id, full_name, description, created_at, updated_at, pushed_at, size,
				stargazers_count, watchers, subscribers_count, language,
				forks, open_issues
			} = data;
			return Promise.props({
				_id: '' + id,
				id,
				name: full_name,
				owner: data.owner.login,
				ownerId: data.owner.id,
				category: 'unk',
				description,
				license: data.license && data.license.key || null,
				createdAt: new Date(created_at),
				updatedAt: new Date(updated_at),
				pushedAt: new Date(pushed_at),
				size,
				language,
				forks,
				stargazers: stargazers_count,
				watchers,
				subscribers: subscribers_count,
				openIssues: open_issues,
				participation: this.fetchParticipants(repoId),
				tags: this.fetchTagsCount(repoId),
				releases: this.fetchReleaseInfo(repoId),
				issues: this.fetchIssuesStats(repoId, id)
			});
		});
	}

	fetchParticipants(repoId) {
		const sumLast = (arr, lastNum = 0) => _.sum(lastNum ? arr.slice(-1 * lastNum) : arr);
		return this.api.repos.getStatsParticipation(repoId).then(({data}) => {
			const all = data.all || [];
			const owner = data.owner || [];

			const stats = {
				commitsOwnerWeek: sumLast(owner, 1),
				commitsOwnerTwoWeeks: sumLast(owner, 2),
				commitsOwnerMonth: sumLast(owner, 4),
				commitsOwnerYear: sumLast(owner),
				commitsAllWeek: sumLast(all, 1),
				commitsAllTwoWeeks: sumLast(all, 2),
				commitsAllMonth: sumLast(all, 4),
				commitsAllYear: sumLast(all),
				commitsOtherWeek: 0,
				commitsOtherTwoWeeks: 0,
				commitsOtherMonth: 0,
				commitsOtherYear: 0,
			};
			stats.commitsOtherWeek = stats.commitsAllWeek - stats.commitsOwnerWeek;
			stats.commitsOtherTwoWeeks = stats.commitsAllTwoWeeks - stats.commitsOwnerTwoWeeks;
			stats.commitsOtherMonth = stats.commitsAllMonth - stats.commitsOwnerMonth;
			stats.commitsOtherYear = stats.commitsAllYear - stats.commitsOwnerYear;
			return stats;
		});
	}

	fetchTagsCount(repoId) {
		return this.api.repos.getTags(Object.assign({per_page: 100}, repoId)).then(({data}) => data.length);
	}

	fetchCommunityProfileCompleteness(repoId) {
		return this.api.repos.getCommunityProfileMetrics({
			owner: repoId.owner,
			name: repoId.repo
		}).then(({data}) => data.health_percentage);
	}

	fetchReleaseInfo(repoId) {
		return this.api.repos.getReleases(Object.assign({per_page: 100}, repoId)).then(({data}) => {
			if (!data.length) {
				return {count: 0, last: null, lastInDays: -1};
			}
			data.forEach((rel) => {
				rel.createdAt = new Date(rel.created_at);
				rel.publishedAt = new Date(rel.published_at);
			});
			const releases = _.sortBy(data, ['publishedAt']).reverse();
			const lastRelease = _.first(releases).publishedAt;
			const avgRelease = calcDiff(releases, 'publishedAt');

			const date = new Date();
			const isRelease = (rel) => !rel.draft && !rel.prerelease;
			date.setMonth(date.getMonth() - 2);
			const releasesInTwoMonth = releases.filter((rel) => rel.publishedAt >= date);
			const avgReleaseTimeLast2Month = calcDiff(releasesInTwoMonth, 'publishedAt');
			const finalReleasesInTwoMonth = releasesInTwoMonth.filter(isRelease);
			const avgFinalReleaseTimeLast2Month = calcDiff(finalReleasesInTwoMonth, 'publishedAt');
			const preReleaseInTwoMonth = releasesInTwoMonth.filter((rel) => !isRelease(rel));

			return {
				count: data.length,
				last: lastRelease,
				lastInDays: roundInDays(Date.now() - lastRelease),
				avgReleaseTime: roundInDays(avgRelease),
				countInTwoMonth: releasesInTwoMonth.length,
				avgReleaseTimeInTwoMonth: roundInDays(avgReleaseTimeLast2Month),
				countFinalInTwoMonth: finalReleasesInTwoMonth.length,
				avgFinalReleaseTimeInTwoMonth: roundInDays(avgFinalReleaseTimeLast2Month),
				countPreReleaseInTwoMonth: preReleaseInTwoMonth.length
			};
		});
	}

	fetchIssues(owner, repo, projectId) {
		const monthAgo = new Date();
		monthAgo.setMonth(monthAgo.getMonth() - 2);
		return fetchRecursive(this.api.issues.getForRepo.bind(this.api.issues), {
			owner, repo, state: 'all', sort: 'created'
		}, (data) => {
			const last = _.last(data);
			const updated = new Date(last.created_at);
			return updated > monthAgo;
		}, 10).then((data) => {
			return data.map((issue) => ({
				_id: `${projectId}.${issue.number}`,
				projectId,
				number: issue.number,
				title: issue.title,
				state: issue.state,
				commentsCount: issue.comments,
				/**
				 * https://developer.github.com/v4/reference/enum/commentauthorassociation/
				 */
				authorAssociation: issue.author_association,
				author: issue.user.login,
				labels: issue.labels.map((label) => label.name),
				createdAt: new Date(issue.created_at),
				closedAt: issue.closed_at && new Date(issue.closed_at),
			}));
		});
	}

	fetchPullRequests(owner, repo, projectId) {
		const monthAgo = new Date();
		monthAgo.setMonth(monthAgo.getMonth() - 2);
		return fetchRecursive(this.api.pullRequests.getAll.bind(this.api.pullRequests), {
			owner, repo, state: 'all', sort: 'created', direction: 'desc'
		}, (data) => {
			const last = _.last(data);
			const created = new Date(last.created_at);
			return created > monthAgo;
		}, 10).then((data) => {
			return data.map((pr) => ({
				_id: `${projectId}.${pr.id}`,
				projectId,
				number: pr.number,
				title: pr.title,
				// commentsCount: pr.comments,
				authorAssociation: pr.author_association,
				author: pr.user.login,
				state: pr.state,
				createdAt: new Date(pr.created_at),
				updatedAt: pr.updated_at && new Date(pr.updated_at),
				closedAt: pr.closed_at && new Date(pr.closed_at),
				mergedAt: pr.merged_at && new Date(pr.merged_at),
				closed: !!pr.closed_at,
				merged: !!pr.merged_at,
			}));
		});
	}

	fetchComments(owner, repo, projectId) {
		const monthAgo = new Date();
		monthAgo.setMonth(monthAgo.getMonth() - 2);
		return fetchRecursive(this.api.issues.getCommentsForRepo.bind(this.api.issues), {
			owner, repo, sort: 'created', direction: 'desc'
		}, (data) => {
			const last = _.last(data);
			const createdAt = new Date(last.created_at);
			return createdAt > monthAgo;
		}, 50).then((comments) => {
			return comments.map((comment) => {
				const issueId = Number(_.last(comment.issue_url.split('/')));
				return {
					_id: `${projectId}.${issueId}.${comment.id}`,
					projectId,
					issueId,
					id: comment.id,
					authorAssociation: comment.author_association,
					author: comment.user.login,
					createdAt: new Date(comment.created_at),
					updatedAt: comment.updated_at && new Date(comment.updated_at),
				};
			});
		});
	}

	fetchIssuesStats({owner, repo}, id) {
		return Promise.props({
			issues: this.fetchIssues(owner, repo, id),
			comments: this.fetchComments(owner, repo, id),
			pullReqs: [] || this.fetchPullRequests(owner, repo, id)
		})
			.then((data) => {
				const commentsGrouped = _.groupBy(data.comments, 'issueId');
				data.issues.forEach((issue) => {
					issue.comments = commentsGrouped[issue.number] || [];
				});
				return data;
			})
			.then(({issues, pullReqs}) => {
				const byTeam = issues.filter(authorInTeam);
				const byOthers = issues.filter((item) => !authorInTeam(item));

				return {
					byTeam: issuesStats(byTeam),
					byOthers: issuesStats(byOthers),
					total: issuesStats(issues),
					// pr: pullRequestsStats(pullReqs)
				};
			})
	}

	fetchBySearch(params) {
		return github.search.repos(params).then(({data}) => {
			return Promise.mapSeries(data.items, (item, index) => {
				// if (index < 29) {
				// 	return;
				// }
				return scrapper.fetch(item.owner.login, item.name, index).catch((err) => {
					console.log('Failed to fetch ', item.owner.login, item.name, err);
					return null;
				});
			});
		})
	}
}

function issuesStats(issues) {
	const closed = issues.filter((issue) => issue.state === 'closed');
	const open = issues.filter((issue) => issue.state === 'open');
	const avgResolveDays = closed.length ? roundInDays(closed.reduce((res, issue) => res + (issue.closedAt - issue.createdAt), 0) / closed.length) : null;
	const withoutComments = issues.reduce((sum, issue) => (!issue.commentsCount) ? sum + 1 : sum, 0);
	return {
		count: issues.length,
		open: open.length,
		closed: closed.length,
		withoutComments,
		avgResolveDays,
		avgResponseHours: avgIssueAnswerTimeInHours(issues)
	};
}

function issueAnswerTime(issue) {
	const comments = issue.comments;
	if (!comments || !comments.length) {
		return -1;
	}
	const teamResponse = _.minBy(comments, (comment) => authorInTeam(comment) ? comment.createdAt : Infinity);
	if (!teamResponse || !authorInTeam(teamResponse)) {
		return -1;
	}
	return teamResponse.createdAt - issue.createdAt;
}

function avgIssueAnswerTimeInHours(issues) {
	const answerTimes = issues.map(issueAnswerTime).filter((diff) => diff > 0);
	const avg = answerTimes.length ? roundInHours(_.sum(answerTimes) / answerTimes.length) : null;
	return avg;
}

/**
 *                authorAssociation: pr.author_association,
 author: pr.user.login,
 state: pr.state,
 createdAt: new Date(pr.created_at),
 updatedAt: pr.updated_at && new Date(pr.updated_at),
 closedAt: pr.closed_at && new Date(pr.closed_at),
 mergedAt: pr.merged_at && new Date(pr.merged_at),
 closed: !!pr.closed_at,
 merged: !!pr.merged_at,
 * @param pullRequests
 * @return {{count, open, closed, withoutComments, avgResolveDays: null, avgResponseHours}}
 */
function pullRequestsStats(pullRequests) {
	const closed = pullRequests.filter((pr) => pr.state === 'closed');
	const open = pullRequests.filter((pr) => pr.state === 'open');
	const avgResolveHours = closed.length ? roundInHours(closed.reduce((res, pr) => res + (pr.closedAt.getTime() - pr.createdAt.getTime()), 0) / closed.length) : null;
	// const withoutComments = open.reduce((sum, pr) => (!pr.comments.length) ? sum + 1 : sum, 0);
	const merged = closed.reduce((sum, pr) => (pr.merged) ? sum + 1 : sum, 0);
	const mergeRatio = closed.length ? +(merged / closed.length).toFixed(2) : null;
	return {
		count: pullRequests.length,
		open: open.length,
		closed: closed.length,
		merged,
		mergeRatio,
		// withoutComments,
		avgResolveHours
	};
}


function transform(data) {
	return _.map(_.compact(data), prepareOut);
}

function rank(data) {
	let ranked = transform(data);
	ranked.forEach((project) => {
		project.score = score(project);
	});
	return _.sortBy(ranked, ['score']).reverse();
}

function print(projects) {
	console.log('Fields: ', Object.keys(projects[0]).join());

	const data = _.map(projects, (p) => _.pick(p, ['name', 'score', 'stargazers', 'id']));
	console.table(data);
}

function score(p) {
	let score = 0.5 * Math.min(p.subscribers / 2, 50) / 50;
	score += 0.5 * Math.min(p.forks / 5, 50) / 50;
	let withoutComments = p['issues.byOthers.withoutComments'];
	let openIn2Months = p['issues.byOthers.open'];
	let issuesIn2Months = p['issues.byOthers.count'];
	if (openIn2Months > 5) {
		// 0.5 expecting that there are less open than closed
		score += 2 * (0.5 - openIn2Months / issuesIn2Months);
	}
	if (openIn2Months > 0) {
		// ration between newly opened issues in 2 months and count of total open issues
		score -= (1 - openIn2Months / p.openIssues) * Math.min(p.openIssues / 100, 1);
	}
	if (p['issues.byOthers.closed']) {
		score += 2 * Math.min(p['issues.byOthers.closed'], 50) / 50;
	}
	if (withoutComments > 0) {
		score -= 4 * withoutComments / issuesIn2Months * (Math.min(withoutComments / 2, 15) / 15);
	}
	if (p['issues.byOthers.avgResponseHours']) {
		// 710 - mean
		score += 0.5 * Math.max(710 - p['issues.byOthers.avgResponseHours'] - 72, 0) / 710;
	}
	if (p['issues.byOthers.avgResolveDays']) {
		score += 0.5 * Math.max(30 - p['issues.byOthers.avgResolveDays'] - 7, 0) / 30;
	}

	if (p['participation.commitsAllTwoWeeks']) {
		score += 0.2;
	} else if (p['participation.commitsAllMonth']) {
		score += 0.1;
	} else if (p['participation.commitsAllYear'] <= 1) {
		score -= 1;
	} else {
		score -= Math.min((p.pushedDaysAgo / 30) / 12, 1);
	}
	score += Math.min(p['participation.commitsAllMonth'], 10) / 10;

	if (p['releases.count']) {
		score += 0.3 * Math.min(p['releases.count'], 14) / 14;
		score += 0.2 * Math.min(p['releases.countInTwoMonth'], 2) / 2;
	}
	score += Math.min(p.tags, 8) / 8;
	return score;
}

const today = new Date();

function prepareOut(doc) {
	const metrics = _.omit(doc, ['_id', '__v', 'owner', 'ownerId', 'releases.last', 'description', 'license', 'createdAt', 'updatedAt', 'pushedAt']);
	if (metrics.releases.last) {
		doc.releases.lastDaysAgo = daysAgo(metrics.releases.last);
	}
	metrics.createdDaysAgo = daysAgo(doc.createdAt);
	metrics.updatedDaysAgo = daysAgo(doc.updatedAt);
	metrics.pushedDaysAgo = daysAgo(doc.pushedAt);
	return flatten(metrics);
}

function daysAgo(date) {
	return roundInDays(today - new Date(date));
}

function fetchRecursive(dataFunc, params, isMoreNeeded, limit = 1, results = []) {
	params.per_page = params.per_page || 100;
	params.page = params.page || 1;
	return dataFunc(params).then(({data}) => {
		if (!data || !data.length) {
			return results;
		}
		params.page += 1;
		if (isMoreNeeded(data) && --limit > 0) {
			results.push(...data);
			return fetchRecursive(dataFunc, params, isMoreNeeded, limit, results);
		}
		results.push(...data.filter((it) => isMoreNeeded([it])));
		return results;
	});
}

const TEAM_MEMBERS = ['MEMBER', 'OWNER', 'COLLABORATOR'];

function authorInTeam(item) {
	return TEAM_MEMBERS.includes(item.authorAssociation);
}

function roundInDays(time) {
	return _.round(time / 1000 / 3600 / 24);
}

function roundInHours(time) {
	return _.round(time / 1000 / 3600);
}


function calcDiff(data, field) {
	if (data.length <= 1) {
		return -1;
	}
	return data.reduce((res, rel) => {
		const val = _.get(rel, field);
		if (res.prev) {
			res.avg += res.prev - val;
		}
		res.prev = val;
		return res;
	}, {avg: 0, prev: null}).avg;
}

function getToken() {
	let token = argv.token || process.env.TOKEN;
	if (!token && fs.existsSync('./token')) {
		token = fs.readFileSync('./token');
	}
	if (!token) {
		throw new Error('Personal access tokens is missing!');
	}
	return token;
}


const scrapper = new Scrapper(github);

Promise.try(() => {
	if (opt.import) {
		return Promise.resolve(require(opt.import + '.json'));
	}
	// https://octokit.github.io/node-github/#api-search-repos
	// sort: stars, forks, updated
	const amount = Number(opt.limit) || 100;
	const limit = amount < 100 ? amount : 100;
	return scrapper.fetchBySearch({q: opt.query, sort: opt.sort, order: opt.order, per_page: limit, page: 1})
		.then((projects) => {
			if (opt.export) {
				fs.writeFileSync(opt.export + '.json', JSON.stringify(projects));
			}
			return projects;
		});
}).then((projects) => {
	const ranked = rank(projects);
	print(ranked);
}).catch((err) => {
	console.error(err);
});