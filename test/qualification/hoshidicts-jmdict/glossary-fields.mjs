/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== 'object') return value
    const normalized = {...value}
    // Import resolves authored image sizes into preferred sizes and intrinsic
    // media dimensions. Compare the authored preference on both sides; the
    // separately attested media probe checks that the referenced bytes persist.
    if (value.tag === 'img') {
        if (typeof value.preferredWidth === 'number') normalized.width = value.preferredWidth
        if (typeof value.preferredHeight === 'number') normalized.height = value.preferredHeight
        delete normalized.preferredWidth
        delete normalized.preferredHeight
    }
    const entries=Object.keys(normalized).sort().map(k=>[k,canonical(normalized[k])])
    return Object.fromEntries(entries)
}

export function glossaryHash(entries) {
    return createHash('sha256').update(JSON.stringify(canonical(entries))).digest('hex')
}

export function compareBrowserGlossaries(entries, title, expected) {
    const observed=new Map()
    for(const entry of entries){
        for(const definition of entry.definitions){
            if(definition.dictionary!==title)continue
            const hash=glossaryHash(definition.entries)
            for(const id of new Set(definition.headwordIndices)){
                const head=entry.headwords[id]
                if(!head)throw Error('Definition points outside its headword group')
                const k=JSON.stringify([head.term,head.reading])
                if(!observed.has(k))observed.set(k,[])
                observed.get(k).push(hash)
            }
        }
    }
    const allKeys=new Set([...Object.keys(expected),...observed.keys()])
    const groups=Array.from(allKeys).map(k=>{
        const source=[...(expected[k]??[])].sort()
        const result=[...(observed.get(k)??[])].sort()
        return {headword:JSON.parse(k),source,result,equal:JSON.stringify(source)===JSON.stringify(result)}
    })
    return {equal:groups.every(g=>g.equal), groups}
}
