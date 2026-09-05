import type { BoardDoc, BoardElement, Op, Page, PaperSettings } from '../src/model/types'

export declare const DEFAULT_PAPER: PaperSettings

export declare function createPage(id: string, name: string): Page
export declare function createDoc(firstPageId?: string): BoardDoc
export declare function applyOp(doc: BoardDoc, op: Op): boolean
export declare function pageElements(doc: BoardDoc, pageId: string): BoardElement[]
export declare function opTargets(doc: BoardDoc, op: Op): BoardElement[]
export declare function pageIsEmpty(doc: BoardDoc, pageId: string): boolean
export declare function trailingPageOp(doc: BoardDoc): Op | null
