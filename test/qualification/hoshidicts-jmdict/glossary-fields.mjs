/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== 'object') return value
    const entries=Object.keys(value).sort().map(k=>[k,canonical(value[k])])
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
