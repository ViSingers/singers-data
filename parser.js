import { Octokit } from "octokit";
import fs from "fs/promises";
import Filter from "bad-words";
import iso6391 from 'iso-639-1';
import 'dotenv/config';

import { promisify } from 'util';

const DB_FILENAME = "data.json";
const MINIFIED_FILENAME = "data.min.json";
const APP_NAME = "ViSingersBot";

const VOICEBANK_TYPES = [
    "utau",
    "paintvoice",
    "diffsinger",
    "rvc",
    "freeloid",
    "vocalsharp",
    "niaoniao",
    "deepvocal",
    "nnsvs"
];

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:(?:\.be\/))([a-zA-Z0-9_-]{11})/g;

const GET_REPO_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { object(expression: "HEAD:") { ... on Tree { entries { name type path object { ... on Blob { text byteSize } } } } } } }`;

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    userAgent: `${APP_NAME}/1.0`
});

const filter = new Filter();

function censorText(text) {
    if (!text) return "";
    try { return filter.clean(text); } catch (e) { return text; }
}

function getSections(rows) {
    const sections = [];
    let sectionName = "";
    let content = [];
    for (const row of rows) {
        if (row.trim().startsWith("#")) {
            if (sectionName) sections.push({ name: sectionName, content: [...content] });
            sectionName = row.replace(/^#+/, "").split("[!")[0].trim();
            content = [];
        } else if (sectionName) {
            content.push(row);
        }
    }
    if (content.length !== 0) sections.push({ name: sectionName, content: [...content] });
    return sections;
}

function getLanguagesList() {
    const allCodes = iso6391.getAllCodes();
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

    return allCodes.map(code => {
        try {
            const fullName = displayNames.of(code);
            const simpleName = fullName.split(" ")[0].toLowerCase();
            return { name: code, fullName: simpleName };
        } catch (e) { return null; }
    })
        .filter(item => item !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadExistingDatabase() {
    try {
        const data = await fs.readFile(DB_FILENAME, 'utf-8');
        const parsed = JSON.parse(data);
        return {
            users: parsed.users || [],
            singers: parsed.singers || [],
            tags: parsed.tags || [],
            languages: parsed.languages || []
        };
    } catch (error) {
        console.log("No existing database found or invalid JSON, starting fresh.");
        return { users: [], singers: [], tags: [], languages: [] };
    }
}

async function main() {
    console.log("Starting GitHub Parser...");

    const existingDb = await loadExistingDatabase();

    const usersMap = new Map(existingDb.users.map(u => [u.id, u]));
    const singersMap = new Map(existingDb.singers.map(s => [s.id, s]));
    const allTagsSet = new Set(existingDb.tags.map(t => t.name));

    let maxLocalTimestamp = 0;
    if (existingDb.singers.length > 0) {
        maxLocalTimestamp = existingDb.singers.reduce((max, s) => {
            const ts = new Date(s.updatedAt).getTime();
            return ts > max ? ts : max;
        }, 0);
    }

    console.log(`Local DB is updated up to: ${new Date(maxLocalTimestamp).toISOString()}`);

    const processedUserIds = new Set();
    const processedRepoIds = new Set();
    const resultSingers = [];
    const languages = getLanguagesList();

    try {
        console.log("Searching repositories...");

        let page = 1;
        let keepFetching = true;

        while (keepFetching) {
            console.log(`\nFetching page ${page}...`);

            const response = await octokit.rest.search.repos({
                q: "topic:visingers",
                sort: "updated",
                order: "desc",
                per_page: 100,
                page: page
            });

            const repos = response.data.items;

            if (repos.length === 0) {
                console.log("No more repositories found.");
                break;
            }

            for (const repo of repos) {
                if (repo.name.includes("template")) continue;

                processedRepoIds.add(repo.id);

                const pushedDate = new Date(repo.pushed_at);
                const updatedDate = new Date(repo.updated_at);
                const effectiveDate = pushedDate > updatedDate ? pushedDate : updatedDate;
                const effectiveTs = effectiveDate.getTime();

                const existingSinger = singersMap.get(repo.id);
                const existingSingerTs = existingSinger ? new Date(existingSinger.updatedAt).getTime() : 0;

                if (existingSinger && existingSingerTs >= effectiveTs) {
                    console.log(`Skipping ${repo.full_name} (Up to date)`);

                    existingSinger.stars = repo.stargazers_count;

                    resultSingers.push(existingSinger);

                    if (existingSinger.tags) existingSinger.tags.forEach(t => allTagsSet.add(t.name));

                    if (existingSinger.creatorId && !processedUserIds.has(existingSinger.creatorId)) {
                        processedUserIds.add(existingSinger.creatorId);
                    }

                    continue;
                }

                console.log(`Parsing ${repo.full_name}...`);

                const githubUserId = repo.owner.id;
                if (!processedUserIds.has(githubUserId) || !usersMap.has(githubUserId)) {
                    let userObj = usersMap.get(githubUserId);
                    let fullName = repo.owner.login;

                    try {
                        const userDetails = await octokit.rest.users.getByUsername({ username: repo.owner.login });
                        fullName = userDetails.data.name || userDetails.data.login;
                    } catch (err) { }

                    if (userObj) {
                        userObj.login = repo.owner.login;
                        userObj.name = fullName;
                    } else {
                        userObj = {
                            id: githubUserId,
                            login: repo.owner.login,
                            name: fullName,
                            isBlocked: false
                        };
                        usersMap.set(githubUserId, userObj);
                    }
                    processedUserIds.add(githubUserId);
                }
                const currentUser = usersMap.get(githubUserId);

                const releasesData = await octokit.rest.repos.listReleases({
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100
                });
                const releases = releasesData.data;

                const graphqlResult = await octokit.graphql(GET_REPO_QUERY, {
                    owner: repo.owner.login,
                    name: repo.name
                });

                const entries = graphqlResult.repository?.object?.entries || [];
                const files = entries.map(entry => ({
                    name: entry.name,
                    type: entry.type,
                    path: entry.path,
                    size: entry.type === "blob" ? entry.object.byteSize : 0,
                    text: entry.type === "blob" ? entry.object.text : null
                }));

                const readmeFile = files.find(f => f.name.toLowerCase() === "readme.md");
                let imageFile = files.find(f => f.name.toLowerCase().match(/^image\.(png|jpg|jpeg|bmp)$/));
                if (!imageFile) imageFile = files.find(f => f.name.toLowerCase().match(/^.*\.(png|jpg|jpeg|bmp)$/));

                if (!readmeFile || !imageFile || !readmeFile.text || readmeFile.size >= 2000000 || imageFile.size >= 20000000) continue;

                const censoredReadme = censorText(readmeFile.text);
                const readmeRows = censoredReadme.split(/\r?\n/).filter(row => row.trim() !== "");
                
                const sections = getSections(readmeRows);
                const descriptionSection = sections[0];
                if (!descriptionSection) continue;

                let singerName = descriptionSection.name;
                const lowerDescName = singerName ? singerName.toLowerCase() : "";
                if (lowerDescName.includes("info") || lowerDescName.includes("desc")) {
                    singerName = repo.name.replace(/_/g, " ");
                }

                const generalInfoSection = sections[1];
                const videosSection = sections.find(s => s.name.toLowerCase() === "videos");
                const termsOfUseSection = sections.find(s => s.name.toLowerCase() === "terms of use");
                const termsOfUseSectionIndex = termsOfUseSection ? sections.indexOf(termsOfUseSection) : -1;

                const voicebankSections = sections.slice(2).filter(s => !["groups", "videos", "terms of use"].includes(s.name.toLowerCase()));
                const voicebanks = [];
                const downloadUrlRegex = new RegExp(`^https://github\\.com/${repo.owner.login}/${repo.name}/releases/download/`, 'i');

                for (const vbSection of voicebankSections) {
                    const vbDescription = vbSection.content.filter(row => !row.trim().startsWith("-")).join("\n").trim();
                    const langRow = vbSection.content.find(row => row.trim().startsWith("- Languages:"));
                    let parsedLanguages = langRow ? langRow.replace("- Languages:", "").split(",").map(l => l.trim().toLowerCase()) : [];
                    const typeRow = vbSection.content.find(row => row.trim().startsWith("- Type:"));
                    let parsedTypeStr = typeRow ? typeRow.replace("- Type:", "").trim().toLowerCase() : null;

                    const vbLanguages = languages.filter(l => parsedLanguages.includes(l.name) || parsedLanguages.includes(l.fullName)).map(l => l.name);
                    const type = VOICEBANK_TYPES.find(t => t === parsedTypeStr);

                    if (!vbLanguages.length || !type) continue;

                    let matchedReleases = releases.filter(r => r.name.startsWith(vbSection.name));
                    matchedReleases.sort((a, b) => {
                        const aDigits = a.name.replace(vbSection.name, "").replace(/\D/g, "");
                        const bDigits = b.name.replace(vbSection.name, "").replace(/\D/g, "");
                        return aDigits.localeCompare(bDigits);
                    });

                    let lastRelease = matchedReleases[0];
                    if (!lastRelease && voicebankSections.length === 1) {
                        lastRelease = [...releases].sort((a, b) => {
                            const aDigits = a.name.replace(/\D/g, "");
                            const bDigits = b.name.replace(/\D/g, "");
                            return aDigits.localeCompare(bDigits);
                        })[0];
                    }

                    if (!lastRelease) continue;
                    const releaseArchive = lastRelease.assets.find(a => a.name.endsWith(".zip"));
                    if (!releaseArchive) continue;

                    const releaseSamples = lastRelease.assets.filter(a => a.name.endsWith(".mp3") || a.name.endsWith(".wav")).map(a => a.browser_download_url);

                    voicebanks.push({
                        type,
                        languages: vbLanguages,
                        sampleUrls: releaseSamples.map(url => url.replace(downloadUrlRegex, "")),
                        url: releaseArchive.browser_download_url.replace(downloadUrlRegex, ""),
                        name: vbSection.name,
                        description: { "en": vbDescription }
                    });
                }

                const description = descriptionSection.content.filter(row => !row.trim().startsWith("!") && !row.trim().startsWith("[")).join("\n").trim();
                const generalInfo = generalInfoSection?.content.filter(row => row.trim().startsWith("-") && row.includes(":")).map(row => row.replace(/^-/, "").trim()) || [];
                const termsOfUse = termsOfUseSection?.content.filter(row => row.trim().startsWith("-") && row.includes(":")).map(row => row.replace(/^-/, "").trim()) || [];

                const parsedTags = repo.topics
                    .filter(t => t.toLowerCase() !== "visingers")
                    .map(t => t.toLowerCase().replace("visingers-", ""))
                    .filter(t => {
                        const isLang = languages.some(l => l.name === t || l.fullName === t);
                        const isType = VOICEBANK_TYPES.some(typ => typ === t);
                        const isUser = t === currentUser.login.toLowerCase();
                        const isDescName = t === singerName.toLowerCase() || singerName.toLowerCase().split(" ").includes(t);
                        return !isLang && !isType && !isUser && !isDescName;
                    });

                const currentSingerTags = [];
                for (const tName of parsedTags) {
                    allTagsSet.add(tName);
                    currentSingerTags.push({ name: tName });
                }

                const videoUrls = videosSection ? [...videosSection.content.join("\n").matchAll(YOUTUBE_REGEX)].map(m => m[1]) : [];

                const galleryDir = files.find(f => f.name.toLowerCase() === "gallery" && f.type === "tree");
                const imageUrls = [];
                if (galleryDir) {
                    try {
                        const galleryContent = await octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: galleryDir.name });
                        if (Array.isArray(galleryContent.data)) {
                            imageUrls.push(...galleryContent.data.filter(f => f.name.endsWith(".png") || f.name.endsWith(".jpg")).map(f => `${repo.default_branch}/${f.path}`));
                        }
                    } catch (e) { }
                }

                const singer = {
                    id: repo.id,
                    avatarUrl: `${repo.default_branch}/${imageFile.path}`,
                    repositoryName: repo.name,
                    name: singerName,
                    siteUrl: repo.homepage,
                    details: { "en": { description, generalInfo, termsOfUse } },
                    creatorId: currentUser.id,
                    updatedAt: effectiveDate.toISOString(),
                    createdAt: repo.created_at,
                    stars: repo.stargazers_count,
                    voicebanks, tags: currentSingerTags, videoUrls, imageUrls
                };

                for (const file of files) {
                    const parts = file.name.split(".");
                    if (file.text && parts.length === 3 && parts[0].toLowerCase() === "readme" && parts[2].toLowerCase() === "md") {
                        const langCode = parts[1];
                        const trRows = censorText(file.text).split(/\r?\n/).filter(r => r.trim() !== "");
                        const trSecs = getSections(trRows);
                        if (!trSecs[0]) continue;
                        const trTerms = (termsOfUseSectionIndex !== -1) ? trSecs[termsOfUseSectionIndex] : null;
                        singer.details[langCode] = {
                            description: trSecs[0].content.filter(r => !r.trim().startsWith("!") && !r.trim().startsWith("[")).join("\n").trim(),
                            generalInfo: trSecs[1]?.content.filter(r => r.trim().startsWith("-") && r.includes(":")).map(r => r.replace(/^-/, "").trim()) || [],
                            termsOfUse: trTerms?.content.filter(r => r.trim().startsWith("-") && r.includes(":")).map(r => r.replace(/^-/, "").trim()) || []
                        };
                        for (const vb of singer.voicebanks) {
                            const tvb = trSecs.find(s => s.name.toLowerCase() === vb.name.toLowerCase());
                            if (tvb) vb.description[langCode] = tvb.content.filter(r => !r.trim().startsWith("-")).join("\n").trim();
                        }
                    }
                }
                resultSingers.push(singer);
            }

            const lastRepoInPage = repos[repos.length - 1];
            const lastRepoDateTs = new Date(lastRepoInPage.updated_at).getTime();
            console.log(`Last repo on page updated at: ${lastRepoInPage.updated_at}`);
            
            if (maxLocalTimestamp > 0 && lastRepoDateTs < maxLocalTimestamp) {
                console.log(`Reached data older than local DB (${new Date(maxLocalTimestamp).toISOString()}). Stopping pagination.`);
                keepFetching = false;
            } else {
                page++;
            }
        }

        if (existingDb.singers.length > 0) {
            let addedCount = 0;
            for (const oldSinger of existingDb.singers) {
                if (!processedRepoIds.has(oldSinger.id)) {
                    resultSingers.push(oldSinger);

                    if (oldSinger.tags) oldSinger.tags.forEach(t => allTagsSet.add(t.name));

                    addedCount++;
                }
            }
            if (addedCount > 0) {
                console.log(`Added ${addedCount} existing singers from old DB (skipped by search).`);
            }
        }

        const finalUsers = Array.from(usersMap.values());
        const finalTags = Array.from(allTagsSet).map(tagName => ({ name: tagName }));

        const dbOutput = {
            users: finalUsers,
            singers: resultSingers,
            tags: finalTags,
            languages
        };

        console.log("Preparing files...");

        const jsonFormatted = JSON.stringify(dbOutput, null, 2);
        const jsonMinified = JSON.stringify(dbOutput);

        await fs.writeFile(DB_FILENAME, jsonFormatted);
        await fs.writeFile(MINIFIED_FILENAME, jsonMinified);

        console.log(`\nSuccess! Saved 2 files:`);
        console.log(`1. ${DB_FILENAME} (Size: ${(jsonFormatted.length / 1024).toFixed(2)} KB)`);
        console.log(`2. ${MINIFIED_FILENAME} (Size: ${(jsonMinified.length / 1024).toFixed(2)} KB)`);

        console.log(`Users: ${finalUsers.length}, Singers: ${resultSingers.length}, Tags: ${finalTags.length}, Languages: ${languages.length}`);

    } catch (e) {
        console.error("Global Error:", e);
    }

}

main();
