"use strict"

const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs')
const { Writable } = require('node:stream');
const { argv } = require('node:process');
const { createHash } = require('node:crypto');
const { dirname } = require('node:path');

const bestanden = [];
const APIROOT="https://omgevingsloketinzage.omgeving.vlaanderen.be/proxy-omv-up/rs/v1/"

async function request(pad, options = {}) {
    const url = APIROOT + pad
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw `request error ${response.status}: ${await response.text()}`
        }
        return await response.json()
    } catch(e) {
        throw new Error(`Fetch failed for ${url}`, {cause: e})
    }
}

async function md5Match(pad, sum) {
    try {
        const hash = createHash("md5");
        const stream = createReadStream(pad);
        for await (const chunk of stream) {
            hash.update(chunk);
        } 
        return hash.digest().equals(sum);
    } catch (e) {
        return false;
    }
}

async function downloadBestand(pad, f) {
    if (! await(md5Match(pad, Buffer.from(f.hash, 'base64')))) {
        console.debug(`download ${pad}`)
        await fs.mkdir(dirname(pad), {recursive: true})
        const url = `${APIROOT}inzage/bestanden/${f.uuid}/download`
        const response = await fetch(url);
        if (!response.ok) {
            throw `request error for ${url} ${response.status}: ${await response.text()}`
        }
        await response.body.pipeTo(Writable.toWeb(createWriteStream(pad, {flags: 'w'})))
    }
    return `${pad} (${f.datumOpladen.join('/')}): ${f.omschrijving || ""}`;
}

async function startDownloadBestand(werkPad, f) {
    const pad = werkPad.concat([f.bestandsnaam]).join('/');
    f.href = `../${pad}`
    bestanden.push(downloadBestand(pad, f))
    return f
}

async function downloadStukken(el, werkPad, onderdeel, level = 0) {
    await el("section", {class:"onderdeel"}, async () => {
        const titel = (onderdeel.titel && (onderdeel.titel.code || onderdeel.titel)) || onderdeel.aard.code
        await el(`h${level + 4}`, {id: onderdeel.uuid}, );
        if (onderdeel.inhoud) {
            await el("pre", onderdeel.inhoud)
        }
        if (onderdeel.dossierstukUuid) {
            const pad = werkPad.concat([onderdeel.dossierstuk.code]);
            await queryAndRenderDownloads(el, pad, onderdeel.dossierstukUuid)
        }
        if (onderdeel.inzageDatablokResources) {
            for(const dataBlok of onderdeel.inzageDatablokResources) {
                await el.formIo(dataBlok)
            }
        }
        if (onderdeel.subOnderdelen) {
            const pad = werkPad.concat([onderdeel.codelijstMetCategorie.code]);
            for (const subOnderdeel of onderdeel.subOnderdelen) {
                await downloadStukken(el, pad, subOnderdeel, level + 1)
            }
        }
        if (onderdeel.details) {
            throw `todo implement`
        }
    })
}

async function downloadOnderdeel(el, werkPad, onderdeel) {
    await el("section", {class:"onderdeel"}, async () => {
        await el("h3", {id: onderdeel.uuid}, onderdeel.inhoud.aard.code);
        await el("pre", onderdeel.inhoud.inhoud)
        const pad = werkPad.concat([onderdeel.inhoud.aard.code])
        const details = await request(`inzage/dossier-onderdelen/${onderdeel.uuid}/details`)
        for(const detail of details.details) {
            await downloadStukken(el, pad, detail);
        }
    })
}

async function queryAndRenderDownloads(el, pad, uuid) {
    const bestanden = await request(`inzage/dossierstukken/${uuid}/bestanden?size=1000`)
    await renderDownloads(el, pad, bestanden.content)
}

async function renderDownloads(el, pad, bestanden) {
    const urls = await Promise.all(bestanden.map(s => startDownloadBestand(pad, s)))
    await el.table(urls.map(url => ({
            BestandsNaam: async () => el("a", {href: url.href, id: url.uuid}, url.bestandsnaam),
            Omschrijving: url.omschrijving,
            Datum: url.datumOpladen.join("-"),
            Grootte: url.grootte,
    })));
}

async function downloadDossierStuk(el, werkPad, dossierStuk) {
    const pad = werkPad.concat(dossierStuk.dossierstukType.code);
    await el("section", {class:"dossierstuk"}, async () => {
        await el("h4", {id: dossierStuk.uuid}, dossierStuk.dossierstukType.code);
        for(const dataBlok of dossierStuk.inzageDatablokResources) {
            await el.formIo(dataBlok)
        }
        await queryAndRenderDownloads(el, pad, dossierStuk.uuid)
    });
}

async function downloadVoorwerp(el, werkPad, voorwerp) {
    const uuid = voorwerp.uuid;
    const pad = werkPad.concat(voorwerp.betreft); 
    await el("section", {class:"voorwerp"}, async () => {
        await el("h2", {id: uuid}, voorwerp.adres);
        await el.dl({
            "betreft": voorwerp.betreft,
            "effecten": el("pre", voorwerp.effecten)
        })

        await el("section", {class:"plannenenfotos"}, async () => {
            await el("h3", "Plannen en Foto's");
            const plannenFotos = await request(`inzage/voorwerpen/${uuid}/plannen-en-fotos?size=1000`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({filters:[]})
            });
            await el.table(plannenFotos.content
                .map(async a => await startDownloadBestand(pad, a))
                .map(async pf => {
                    pf = await pf
                    return {
                        BestandsNaam: async () => el("a", {href: pf.href, id: pf.uuid}, pf.bestandsnaam),
                        TekeningSoort: pf.tekeningsoort.code,
                        PlanAanduiding: pf.planAanduiding,
                        Toestand: pf.toestand.code,
                        Datum: pf.datumOpladen.join("-"),
                        Grootte: pf.grootte,
                    }
                }))
        })
    })


    for (const onderdeel of await request(`inzage/voorwerpen/${uuid}/onderdelen`)) {
        await downloadOnderdeel(el, pad, onderdeel)
    }

    await el("section", {class:"dossierstukken"}, async () => {
        await el("h3", "DossierStukken");
        const stukken = await request(`inzage/voorwerpen/${uuid}/dossierstukken`);
        for(const stuk of stukken) {
            await downloadDossierStuk(el, pad, stuk)
        }
    })
}

async function downloadGebeurtenis(el, werkPad, gebeurtenis) {
    await el("section", async () => {
        await el("h3", gebeurtenis.gevraagdAan || gebeurtenis.verantwoordelijke)
        if (gebeurtenis.adviesVraagGebeurtenisUuid) {
            await el.dl({
                aantalAdviezen: gebeurtenis.aantalAdviezen,
                aardLaatsteAdvies: gebeurtenis.aardLaatsteAdvies,
                adviesVraagDatum: gebeurtenis.adviesVraagDatum,
                datumLaatsteAdviesVerlening: gebeurtenis.datumLaatsteAdviesVerlening,
                gevraagdAan: gebeurtenis.gevraagdAan,
                voorwaarden : gebeurtenis.voorwaarden ? "ja": "nee",
                gevraagdDoor: gebeurtenis.gevraagdDoor,
            })
        }
        const pad = werkPad.concat(gebeurtenis.gevraagdAan || gebeurtenis.verantwoordelijke)
        const inhoud = await request(`inzage/gebeurtenissen/${gebeurtenis.uuid || gebeurtenis.adviesVraagGebeurtenisUuid}`)

        for (const onderdeel of inhoud) {
            if (onderdeel.tabel) {
                await el.tabel(onderdeel.tabel)
            }
            if (onderdeel.datablokken) {
                for(const datablok of onderdeel.datablokken) {
                    await el.formIo(datablok)
                }
            }
            await el("section", async () => {
                await el("h4", onderdeel.titel)
                await renderDownloads(el, pad.concat(onderdeel.titel), onderdeel.bestanden)
            })
        }
    })
}

async function downloadGebeurtenissen(el, pad, uuid, type) {
    await el("section", {class: `gebeurtenis ${type}`}, async () => {
        await el("h2", type)
        const adviezen = await request(`inzage/projectfasen/${uuid}/${type}-gebeurtenissen?size=1000`)
        for(const gebeurtenis of adviezen.content) {
            await downloadGebeurtenis(el, pad.concat(type), gebeurtenis)
        }
    })
}

async function downloadProcedure(el, werkPad, uuid) {
    await el("section", {class: "procedure"}, async () => {
        await el("h1", "Procedure")    
        const procedure = await request(`inzage/projecten/${uuid}/procedure`);
        for (const stap of procedure) {
            await el("section", {class: "procedureStap"}, async () => {
                await el("h2", {id: stap.uuid}, stap.inhoud.aard.code)   
                const pad = werkPad.concat(stap.inhoud.aard.code)
                for(const subOnderdeel of stap.subOnderdelen) {
                    await downloadStukken(el, pad, subOnderdeel)
                }
                await downloadGebeurtenissen(el, pad, stap.uuid, "advies")
                await downloadGebeurtenissen(el, pad, stap.uuid, "beslissing")
                await downloadGebeurtenissen(el, pad, stap.uuid, "andere")
            })
        }
    })
}


async function htmlDoc(pad, naam) {
    const doc = await fs.open(pad.concat(naam).join('/'), 'w');
    var depth = 0;
    doc.write("<!doctype html>\n")
    const el = async function(elName, attrs, content) {
        if (content === undefined && (typeof attrs !== 'object')) {
            content = attrs
            attrs = {}
        }
        if (content === undefined) {
            content = ""
        }
        const attrString = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${value}"`).join("")
        const padding = "\t".repeat(depth)
        if (!elName) {
            doc.write(String(content))
        } 
        doc.write(`${padding}<${elName}${attrString}>`)
        if (typeof content !== 'function') {
            doc.write(String(content))
        } else {
            doc.write("\n")
            depth = depth + 1
            await content()
            doc.write(padding)
            depth = depth - 1
        }
        doc.write(`</${elName}>\n`)
    }
    el.dl = async function(content) {
        await el("dl", async () => {
            for(const [key, value] of Object.entries(content)) {
                await el("dt", key)
                await el("dd", value)
            }
        })
    }
    el.table = async function(content) {
        if (content.length > 0) {
            const headers = Object.keys(await content[0]);
            await el("table", async () => {
                await el("thead", async () => {
                    await el("tr", async () => {
                        for(const key of headers) {
                            await el("th", await key)
                        }
                    })
                })
                await el("tbody", async () => {
                    for await (const row of content) {
                        await el("tr", async () => {
                            for(const key of headers) {
                                await el("td", row[key])
                            }
                        })
                    }
                })
            })
        }
    }
    el.tabel = async function (tabel) {        
        await el("table", {id: tabel.uuid}, async () => {
            await el("caption", tabel.titel)
            await el("thead", async () => {
                await el("tr", async () => {
                    for(const naam of tabel.kolomNamen) {
                        await el("th", naam.value)
                    }
                })
            })
            await el("tbody", async () => {
                for await (const rij of tabel.rijen) {
                    await el("tr", async () => {
                        for(const cel of rij.data) {
                            await el("td", cel.value)
                        }
                    })
                }
            })
        })
    }
    el.formIo = async function(form) {
        await el("div", {id: form.uuid, class: "formio"})
        var formContent = await request(`parameters/datablokDefinitie-form-io-formulier/${form.blokId}`)
        await el("script", `
            Formio.createForm(document.getElementById("${form.uuid}"), ${JSON.stringify(formContent)}, {readOnly: true}).then(f => f.submission = {data:${form.datablokinhoud}});
        `);
    }
    return el;
}

async function download(projectId) {
    const pad = [projectId]
    const el = await htmlDoc(pad, "inhoud.html")
    await el("html", async () => {
        const header = await request(`inzage/projecten/header?projectnummer=${projectId}`);
        await el("head", async () => {
            await el("title", `${header.projectnummer}: ${header.projectnaam}`)
            await el("link", {rel:"stylesheet", href:"https://cdn.form.io/formiojs/formio.form.min.css"})
            await el("link", {rel:"stylesheet", href:"https://cdn.jsdelivr.net/npm/bootstrap@4.6.0/dist/css/bootstrap.min.css"})
            await el("style", ".btn-md:disabled {display: none;}");
        })
        
        await el("body", async () => {
            await el("script", {src: "https://cdn.form.io/formiojs/formio.full.min.js", crossorigin:"anonymous"})
            await el("section", async () => {
                await el("h1", {id: header.uuid}, `${header.projectnummer}: ${header.projectnaam}`)
                await el.dl({
                    status: header.beroepOfBezwaar,
                    toestand: header.toestand,
                    gegenereerd: new Date().toISOString()
                })
            })
            const projectInfo = await request(`inzage/projecten/${header.uuid}/projectinformatie`);
            if (projectInfo.subOnderdelen.length > 0) {
                console.warn("TODO: projectInfo Not Empty")
            }

            await el("section", {class: "inhoud"}, async () => {
                await el("h1", "Inhoud Aanvraag")                
                const topVoorwerpen = await request(`inzage/projecten/${header.uuid}/top-voorwerpen?size=1000`);
                for(const voorwerp of topVoorwerpen.content) {
                    await downloadVoorwerp(el, pad, voorwerp)
                }
            })
            await downloadProcedure(el, pad, header.uuid)
            const footer = `automatisch gegenereerd met https://github.com/steven-aerts/omvdownloader ${projectId} op ${new Date()}`
            await el("footer", async () => {
                await el("p", footer)
            })
            const downloadLog = await fs.open(`${projectId}/bestanden.txt`, 'w');
            await downloadLog.write(`# ${projectId}: ${header.projectnaam}\n`)
            await downloadLog.write(`## ${footer}\n\n## Bestanden:\n`)
            await downloadLog.write((await Promise.all(bestanden)).sort().join('\n'));
        })
    })
}

(async () => {
    if (argv.length != 3) {
        throw `${argv[0]} moet opgeroepen worden met OMV nummer als enige argument.`
    }
    var omvValid = argv[2].match(/^(OMV_)?([0-9]{10})$/);
    if (!omvValid) {
        throw `Ongekend formaat voor OMV nummer: ${argv[2]}`
    }
    await download(`OMV_${omvValid[2]}`);
})().catch(e => {
    console.error(e)
})
