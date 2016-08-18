/*!
 * VisualEditor DataModel Transaction class.
 *
 * @copyright 2011-2016 VisualEditor Team and others; see http://ve.mit-license.org
 */

/**
 * Transaction on ve.dm.ElementLinearData, preserving ve.dm.Document tree validity
 *
 * A transaction represents a mapping on ve.dm.ElementLinearData, from one state (the start
 * state) to another (the end state). The transaction is guaranteed not to break tree validity:
 * if the start state represents a syntactically valid ve.dm.Document tree (without unbalanced
 * tags, bare listItems, bare table cells etc), then the end state tree must be syntactically
 * valid too.
 *
 * A transaction is comprised of a list of operations, which must preserve tree validity as a
 * whole, though each individual operation may not. For example, a DivNode wrapping can be
 * removed by one operation removing the 'div' and another removing the '/div'.  The
 * ve.dm.Transaction.newFrom* methods help build transactions that preserve tree validity.
 *
 * @class
 * @constructor
 * @param {Object[]} [operations] Operations preserving tree validity as a whole; default []
 */
ve.dm.Transaction = function VeDmTransaction( operations ) {
	this.operations = operations || [];
	this.applied = false;
};

/* Static Methods */

/**
 * Generate a transaction that replaces data in a range.
 *
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {ve.Range} range Range of data to remove
 * @param {Array} data Data to insert
 * @param {boolean} [removeMetadata=false] Remove metadata instead of collapsing it
 * @return {ve.dm.Transaction} Transaction that replaces data
 * @throws {Error} Invalid range
 */
ve.dm.Transaction.newFromReplacement = function ( doc, range, data, removeMetadata ) {
	var endOffset,
		tx = new ve.dm.Transaction();
	endOffset = tx.pushRemoval( doc, 0, range, removeMetadata );
	endOffset = tx.pushInsertion( doc, endOffset, endOffset, data );
	tx.pushFinalRetain( doc, endOffset );
	return tx;
};

/**
 * Generate a transaction that inserts data at an offset.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {number} offset Offset to insert at
 * @param {Array} data Data to insert
 * @return {ve.dm.Transaction} Transaction that inserts data
 */
ve.dm.Transaction.newFromInsertion = function ( doc, offset, data ) {
	var tx = new ve.dm.Transaction(),
		endOffset = tx.pushInsertion( doc, 0, offset, data );
	// Retain to end of document, if needed (for completeness)
	tx.pushFinalRetain( doc, endOffset );
	return tx;
};

/**
 * Generate a transaction that removes data from a range.
 *
 * There are three possible results from a removal:
 *
 * - Remove content only
 *    - Occurs when the range starts and ends on elements of different type, depth or ancestry
 * - Remove entire elements and their content
 *    - Occurs when the range spans across an entire element
 * - Merge two elements by removing the end of one and the beginning of another
 *    - Occurs when the range starts and ends on elements of similar type, depth and ancestry
 *
 * This function uses the following logic to decide what to actually remove:
 *
 * 1. Elements are only removed if range being removed covers the entire element
 * 2. Elements can only be merged if {@link ve.dm.Node#canBeMergedWith} returns true
 * 3. Merges take place at the highest common ancestor
 *
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {ve.Range} range Range of data to remove
 * @param {boolean} [removeMetadata=false] Remove metadata instead of collapsing it
 * @return {ve.dm.Transaction} Transaction that removes data
 * @throws {Error} Invalid range
 */
ve.dm.Transaction.newFromRemoval = function ( doc, range, removeMetadata ) {
	var tx = new ve.dm.Transaction(),
		endOffset = tx.pushRemoval( doc, 0, range, removeMetadata );

	// Ensure no transaction leaves the document in a completely empty state
	if ( range.start === 0 && range.end >= doc.getInternalList().getListNode().getOuterRange().start ) {
		endOffset = tx.pushInsertion( doc, endOffset, endOffset, [
			{ type: 'paragraph' },
			{ type: '/paragraph' }
		] );
	}

	// Retain to end of document, if needed (for completeness)
	tx.pushFinalRetain( doc, endOffset );
	return tx;
};

/**
 * Build a transaction that inserts the contents of a document at a given offset.
 *
 * This is typically used to merge changes to a document slice back into the main document. If newDoc
 * is a document slice of doc, it's assumed that there were no changes to doc's internal list since
 * the slice, so any differences between internal items that doc and newDoc have in common will
 * be resolved in newDoc's favor.
 *
 * @param {ve.dm.Document} doc Main document in the state to which the transaction start applies
 * @param {number} offset Offset to insert at
 * @param {ve.dm.Document} newDoc Document to insert
 * @param {ve.Range} [newDocRange] Range from the new document to insert (defaults to entire document)
 * @return {ve.dm.Transaction} Transaction that inserts the nodes and updates the internal list
 */
ve.dm.Transaction.newFromDocumentInsertion = function ( doc, offset, newDoc, newDocRange ) {
	var i, len, listMerge, data, metadata, listData, listMetadata, linearData,
		oldEndOffset, newEndOffset, tx, insertion, spliceItemRange, spliceListNodeRange,
		listNode = doc.internalList.getListNode(),
		listNodeRange = listNode.getRange(),
		newListNode = newDoc.internalList.getListNode(),
		newListNodeRange = newListNode.getRange(),
		newListNodeOuterRange = newListNode.getOuterRange();

	if ( newDocRange ) {
		data = new ve.dm.ElementLinearData( doc.getStore(), newDoc.getData( newDocRange, true ) );
		metadata = new ve.dm.MetaLinearData( doc.getStore(), newDoc.getMetadata( newDocRange, true ) );
	} else {
		// Get the data and the metadata, but skip over the internal list
		data = new ve.dm.ElementLinearData( doc.getStore(),
			newDoc.getData( new ve.Range( 0, newListNodeOuterRange.start ), true ).concat(
				newDoc.getData( new ve.Range( newListNodeOuterRange.end, newDoc.data.getLength() ), true )
			)
		);
		metadata = new ve.dm.MetaLinearData( doc.getStore(),
			newDoc.getMetadata( new ve.Range( 0, newListNodeOuterRange.start ), true ).concat(
				newListNodeOuterRange.end < newDoc.data.getLength() ? newDoc.getMetadata(
					new ve.Range( newListNodeOuterRange.end + 1, newDoc.data.getLength() ), true
				) : []
			)
		);
		// TODO deal with metadata right before and right after the internal list
	}

	// Merge the stores
	doc.getStore().merge( newDoc.getStore() );

	listMerge = doc.internalList.merge( newDoc.internalList, newDoc.origInternalListLength || 0 );
	// Remap the indexes in the data
	data.remapInternalListIndexes( listMerge.mapping, doc.internalList );
	// Get data for the new internal list
	if ( newDoc.origDoc === doc ) {
		// newDoc is a document slice based on doc, so all the internal list items present in doc
		// when it was cloned are also in newDoc. We need to get the newDoc version of these items
		// so that changes made in newDoc are reflected.
		if ( newDoc.origInternalListLength > 0 ) {
			oldEndOffset = doc.internalList.getItemNode( newDoc.origInternalListLength - 1 ).getOuterRange().end;
			newEndOffset = newDoc.internalList.getItemNode( newDoc.origInternalListLength - 1 ).getOuterRange().end;
		} else {
			oldEndOffset = listNodeRange.start;
			newEndOffset = newListNodeRange.start;
		}
		linearData = new ve.dm.ElementLinearData(
			doc.getStore(),
			newDoc.getData( new ve.Range( newListNodeRange.start, newEndOffset ), true )
		);
		listData = linearData.data
			.concat( doc.getData( new ve.Range( oldEndOffset, listNodeRange.end ), true ) );
		listMetadata = newDoc.getMetadata( new ve.Range( newListNodeRange.start, newEndOffset ), true )
			.concat( doc.getMetadata( new ve.Range( oldEndOffset, listNodeRange.end ), true ) );
	} else {
		// newDoc is brand new, so use doc's internal list as a base
		listData = doc.getData( listNodeRange, true );
		listMetadata = doc.getMetadata( listNodeRange, true );
	}
	for ( i = 0, len = listMerge.newItemRanges.length; i < len; i++ ) {
		linearData = new ve.dm.ElementLinearData(
			doc.getStore(),
			newDoc.getData( listMerge.newItemRanges[ i ], true )
		);
		listData = listData.concat( linearData.data );
		// We don't have to worry about merging metadata at the edges, because there can't be
		// metadata between internal list items
		listMetadata = listMetadata.concat( newDoc.getMetadata( listMerge.newItemRanges[ i ], true ) );
	}

	tx = new ve.dm.Transaction();

	if ( offset <= listNodeRange.start ) {
		// offset is before listNodeRange
		// First replace the node, then the internal list

		// Fix up the node insertion
		insertion = doc.fixupInsertion( data.data, offset );
		tx.pushRetain( insertion.offset );
		tx.pushReplace( doc, insertion.offset, insertion.remove, insertion.data, metadata.data );
		tx.pushRetain( listNodeRange.start - ( insertion.offset + insertion.remove ) );
		tx.pushReplace( doc, listNodeRange.start, listNodeRange.end - listNodeRange.start,
			listData, listMetadata
		);
		tx.pushFinalRetain( doc, listNodeRange.end );
	} else if ( offset >= listNodeRange.end ) {
		// offset is after listNodeRange
		// First replace the internal list, then the node

		// Fix up the node insertion
		insertion = doc.fixupInsertion( data.data, offset );
		tx.pushRetain( listNodeRange.start );
		tx.pushReplace( doc, listNodeRange.start, listNodeRange.end - listNodeRange.start,
			listData, listMetadata
		);
		tx.pushRetain( insertion.offset - listNodeRange.end );
		tx.pushReplace( doc, insertion.offset, insertion.remove, insertion.data, metadata.data );
		tx.pushFinalRetain( doc, insertion.offset + insertion.remove );
	} else if ( offset >= listNodeRange.start && offset <= listNodeRange.end ) {
		// offset is within listNodeRange
		// Merge data into listData, then only replace the internal list
		// Find the internalItem we are inserting into
		i = 0;
		// Find item node in doc
		while (
			( spliceItemRange = doc.internalList.getItemNode( i ).getRange() ) &&
			offset > spliceItemRange.end
		) {
			i++;
		}

		if ( newDoc.origDoc === doc ) {
			// Get spliceItemRange from newDoc
			spliceItemRange = newDoc.internalList.getItemNode( i ).getRange();
			spliceListNodeRange = newListNodeRange;
		} else {
			// Get spliceItemRange from doc; the while loop has already set it
			spliceListNodeRange = listNodeRange;
		}
		ve.batchSplice( listData, spliceItemRange.start - spliceListNodeRange.start,
			spliceItemRange.end - spliceItemRange.start, data.data );
		ve.batchSplice( listMetadata, spliceItemRange.start - spliceListNodeRange.start,
			spliceItemRange.end - spliceItemRange.start, metadata.data );

		tx.pushRetain( listNodeRange.start );
		tx.pushReplace( doc, listNodeRange.start, listNodeRange.end - listNodeRange.start,
			listData, listMetadata
		);
		tx.pushFinalRetain( doc, listNodeRange.end );
	}
	return tx;
};

/**
 * Generate a transaction that changes one or more attributes.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {number} offset Offset of element
 * @param {Object.<string,Mixed>} attr List of attribute key and value pairs, use undefined value
 *  to remove an attribute
 * @return {ve.dm.Transaction} Transaction that changes an element
 * @throws {Error} Cannot set attributes to non-element data
 * @throws {Error} Cannot set attributes on closing element
 */
ve.dm.Transaction.newFromAttributeChanges = function ( doc, offset, attr ) {
	var tx = new ve.dm.Transaction(),
		data = doc.getData();
	// Verify element exists at offset
	if ( data[ offset ].type === undefined ) {
		throw new Error( 'Cannot set attributes to non-element data' );
	}
	// Verify element is not a closing
	if ( data[ offset ].type.charAt( 0 ) === '/' ) {
		throw new Error( 'Cannot set attributes on closing element' );
	}
	// Retain up to element
	tx.pushRetain( offset );
	// Change attributes
	tx.pushAttributeChanges( attr, data[ offset ].attributes || {} );
	// Retain to end of document
	tx.pushFinalRetain( doc, offset );
	return tx;
};

/**
 * Generate a transaction that annotates content.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {ve.Range} range Range to annotate
 * @param {string} method Annotation mode
 *  - `set`: Adds annotation to all content in range
 *  - `clear`: Removes instances of annotation from content in range
 * @param {ve.dm.Annotation} annotation Annotation to set or clear
 * @return {ve.dm.Transaction} Transaction that annotates content
 */
ve.dm.Transaction.newFromAnnotation = function ( doc, range, method, annotation ) {
	var covered, type, annotatable,
		tx = new ve.dm.Transaction(),
		data = doc.data,
		index = doc.getStore().index( annotation ),
		i = range.start,
		span = i,
		on = false,
		insideContentNode = false,
		ignoreChildrenDepth = 0;

	// Iterate over all data in range, annotating where appropriate
	while ( i < range.end ) {
		if ( data.isElementData( i ) ) {
			type = data.getType( i );
			if ( ve.dm.nodeFactory.shouldIgnoreChildren( type ) ) {
				ignoreChildrenDepth += data.isOpenElementData( i ) ? 1 : -1;
			}
			if ( ve.dm.nodeFactory.isNodeContent( type ) ) {
				if ( method === 'set' && !ve.dm.nodeFactory.canNodeTakeAnnotationType( type, annotation ) ) {
					// Blacklisted annotations can't be set
					annotatable = false;
				} else {
					annotatable = true;
				}
			} else {
				// Structural nodes are never annotatable
				annotatable = false;
			}
		} else {
			// Text is always annotatable
			annotatable = true;
		}
		// No annotations if we're inside an ignoreChildren node
		annotatable = annotatable && !ignoreChildrenDepth;
		if (
			!annotatable ||
			( insideContentNode && !data.isCloseElementData( i ) )
		) {
			// Structural element opening or closing, or entering a content node
			if ( on ) {
				tx.pushRetain( span );
				tx.pushStopAnnotating( method, index );
				span = 0;
				on = false;
			}
		} else if (
			( !data.isElementData( i ) || !data.isCloseElementData( i ) ) &&
			!insideContentNode
		) {
			// Character or content element opening
			if ( data.isElementData( i ) ) {
				insideContentNode = true;
			}
			if ( method === 'set' ) {
				// Don't re-apply matching annotation
				covered = data.getAnnotationsFromOffset( i ).containsComparable( annotation );
			} else {
				// Expect comparable annotations to be removed individually otherwise
				// we might try to remove more than one annotation per character, which
				// a single transaction can't do.
				covered = data.getAnnotationsFromOffset( i ).contains( annotation );
			}
			if ( ( covered && method === 'set' ) || ( !covered && method === 'clear' ) ) {
				// Skip annotated content
				if ( on ) {
					tx.pushRetain( span );
					tx.pushStopAnnotating( method, index );
					span = 0;
					on = false;
				}
			} else {
				// Cover non-annotated content
				if ( !on ) {
					tx.pushRetain( span );
					tx.pushStartAnnotating( method, index );
					span = 0;
					on = true;
				}
			}
		} else if ( data.isCloseElementData( i ) ) {
			// Content closing, skip
			insideContentNode = false;
		}
		span++;
		i++;
	}
	tx.pushRetain( span );
	if ( on ) {
		tx.pushStopAnnotating( method, index );
	}
	tx.pushFinalRetain( doc, range.end );
	return tx;
};

/**
 * Generate a transaction that inserts metadata elements.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {number} offset Offset of element
 * @param {number} index Index of metadata cursor within element
 * @param {Array} newElements New elements to insert
 * @return {ve.dm.Transaction} Transaction that inserts the metadata elements
 */
ve.dm.Transaction.newFromMetadataInsertion = function ( doc, offset, index, newElements ) {
	var tx = new ve.dm.Transaction(),
		data = doc.metadata,
		elements = data.getData( offset ) || [];

	if ( newElements.length === 0 ) {
		return tx; // no-op
	}

	// Retain up to element
	tx.pushRetain( offset );
	// Retain up to metadata element (second dimension)
	tx.pushRetainMetadata( index );
	// Insert metadata elements
	tx.pushReplaceMetadata(
		[], newElements
	);
	// Retain up to end of metadata elements (second dimension)
	tx.pushRetainMetadata( elements.length - index );
	// Retain to end of document
	tx.pushFinalRetain( doc, offset, elements.length );
	return tx;
};

/**
 * Generate a transaction that removes metadata elements.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {number} offset Offset of element
 * @param {ve.Range} range Range of metadata to remove
 * @return {ve.dm.Transaction} Transaction that removes metadata elements
 * @throws {Error} Cannot remove metadata from empty list
 * @throws {Error} Range out of bounds
 */
ve.dm.Transaction.newFromMetadataRemoval = function ( doc, offset, range ) {
	var selection,
		tx = new ve.dm.Transaction(),
		data = doc.metadata,
		elements = data.getData( offset ) || [];

	if ( !elements.length ) {
		throw new Error( 'Cannot remove metadata from empty list' );
	}

	if ( range.start < 0 || range.end > elements.length ) {
		throw new Error( 'Range out of bounds' );
	}

	selection = elements.slice( range.start, range.end );

	if ( selection.length === 0 ) {
		return tx; // no-op.
	}

	// Retain up to element
	tx.pushRetain( offset );
	// Retain up to metadata element (second dimension)
	tx.pushRetainMetadata( range.start );
	// Remove metadata elements
	tx.pushReplaceMetadata(
		selection, []
	);
	// Retain up to end of metadata elements (second dimension)
	tx.pushRetainMetadata( elements.length - range.end );
	// Retain to end of document (unless we're already off the end )
	tx.pushFinalRetain( doc, offset, elements.length );
	return tx;
};

/**
 * Generate a transaction that replaces a single metadata element.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {number} offset Offset of element
 * @param {number} index Index of metadata cursor within element
 * @param {Object} newElement New element to insert
 * @return {ve.dm.Transaction} Transaction that replaces a metadata element
 * @throws {Error} Metadata index out of bounds
 */
ve.dm.Transaction.newFromMetadataElementReplacement = function ( doc, offset, index, newElement ) {
	var oldElement,
		tx = new ve.dm.Transaction(),
		data = doc.getMetadata(),
		elements = data[ offset ] || [];

	if ( index >= elements.length ) {
		throw new Error( 'Metadata index out of bounds' );
	}

	oldElement = elements[ index ];

	// Retain up to element
	tx.pushRetain( offset );
	// Retain up to metadata element (second dimension)
	tx.pushRetainMetadata( index );
	// Remove metadata elements
	tx.pushReplaceMetadata(
		[ oldElement ], [ newElement ]
	);
	// Retain up to end of metadata elements (second dimension)
	tx.pushRetainMetadata( elements.length - index - 1 );
	// Retain to end of document (unless we're already off the end )
	tx.pushFinalRetain( doc, offset, elements.length );
	return tx;
};

/**
 * Generate a transaction that converts elements that can contain content.
 *
 * @static
 * @method
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {ve.Range} range Range to convert
 * @param {string} type Symbolic name of element type to convert to
 * @param {Object} attr Attributes to initialize element with
 * @return {ve.dm.Transaction} Transaction that converts content branches
 */
ve.dm.Transaction.newFromContentBranchConversion = function ( doc, range, type, attr ) {
	var i, selected, branch, branchOuterRange,
		tx = new ve.dm.Transaction(),
		selection = doc.selectNodes( range, 'leaves' ),
		opening = { type: type },
		closing = { type: '/' + type },
		previousBranch,
		previousBranchOuterRange;
	// Add attributes to opening if needed
	if ( ve.isPlainObject( attr ) ) {
		opening.attributes = attr;
	} else {
		attr = {};
	}
	// Replace the wrappings of each content branch in the range
	for ( i = 0; i < selection.length; i++ ) {
		selected = selection[ i ];
		branch = selected.node.isContent() ? selected.node.getParent() : selected.node;
		if ( branch.canContainContent() ) {
			// Skip branches that are already of the target type and have all attributes in attr
			// set already.
			if ( branch.getType() === type && ve.compare( attr, branch.getAttributes(), true ) ) {
				continue;
			}
			branchOuterRange = branch.getOuterRange();
			// Don't convert the same branch twice
			if ( branch === previousBranch ) {
				continue;
			}

			// Retain up to this branch, considering where the previous one left off
			tx.pushRetain(
				branchOuterRange.start - ( previousBranch ? previousBranchOuterRange.end : 0 )
			);
			if ( branch.getType() === type ) {
				// Same type, different attributes, so we only need an attribute change
				tx.pushAttributeChanges( attr, branch.getAttributes() );
				// Retain the branch, including its opening and closing
				tx.pushRetain( branch.getOuterLength() );
			} else {
				// Types differ, so we need to replace the opening and closing
				// Replace the opening
				tx.pushReplace( doc, branchOuterRange.start, 1, [ ve.copy( opening ) ] );
				// Retain the contents
				tx.pushRetain( branch.getLength() );
				// Replace the closing
				tx.pushReplace( doc, branchOuterRange.end - 1, 1, [ ve.copy( closing ) ] );
			}
			// Remember this branch and its range for next time
			previousBranch = branch;
			previousBranchOuterRange = branchOuterRange;
		}
	}
	// Retain until the end
	tx.pushFinalRetain( doc, previousBranch ? previousBranchOuterRange.end : 0 );
	return tx;
};

/**
 * Generate a transaction that wraps, unwraps or replaces structure.
 *
 * The unwrap parameters are checked against the actual model data, and
 * an exception is thrown if the type fields don't match. This means you
 * can omit attributes from the unwrap parameters, those are automatically
 * picked up from the model data instead.
 *
 * NOTE: This function currently does not fix invalid parent/child relationships, so it will
 * happily convert paragraphs to listItems without wrapping them in a list if that's what you
 * ask it to do. We'll probably fix this later but for now the caller is responsible for giving
 * valid instructions.
 *
 * Changing a paragraph to a header:
 *     Before: [ {type: 'paragraph'}, 'a', 'b', 'c', {type: '/paragraph'} ]
 *     newFromWrap( new ve.Range( 1, 4 ), [ {type: 'paragraph'} ], [ {type: 'heading', level: 1 } ] );
 *     After: [ {type: 'heading', level: 1 }, 'a', 'b', 'c', {type: '/heading'} ]
 *
 * Changing a set of paragraphs to a list:
 *     Before: [ {type: 'paragraph'}, 'a', {type: '/paragraph'}, {'type':'paragraph'}, 'b', {'type':'/paragraph'} ]
 *     newFromWrap( new ve.Range( 0, 6 ), [], [ {type: 'list' } ], [], [ {type: 'listItem', attributes: {styles: ['bullet']}} ] );
 *     After: [ {type: 'list'}, {type: 'listItem', attributes: {styles: ['bullet']}}, {'type':'paragraph'} 'a',
 *              {type: '/paragraph'}, {type: '/listItem'}, {type: 'listItem', attributes: {styles: ['bullet']}},
 *              {type: 'paragraph'}, 'b', {type: '/paragraph'}, {type: '/listItem'}, {type: '/list'} ]
 *
 * @param {ve.dm.Document} doc Document in pre-transaction state
 * @param {ve.Range} range Range to wrap/unwrap/replace around
 * @param {Array} unwrapOuter Opening elements to unwrap. These must be immediately *outside* the range
 * @param {Array} wrapOuter Opening elements to wrap around the range
 * @param {Array} unwrapEach Opening elements to unwrap from each top-level element in the range
 * @param {Array} wrapEach Opening elements to wrap around each top-level element in the range
 * @return {ve.dm.Transaction}
 */
ve.dm.Transaction.newFromWrap = function ( doc, range, unwrapOuter, wrapOuter, unwrapEach, wrapEach ) {
	var i, j, unwrapOuterData, startOffset, unwrapEachData, closingUnwrapEach, closingWrapEach,
		tx = new ve.dm.Transaction(),
		depth = 0;

	// Function to generate arrays of closing elements in reverse order
	function closingArray( openings ) {
		var i,
			closings = [],
			len = openings.length;
		for ( i = 0; i < len; i++ ) {
			closings[ closings.length ] = { type: '/' + openings[ len - i - 1 ].type };
		}
		return closings;
	}
	closingUnwrapEach = closingArray( unwrapEach );
	closingWrapEach = closingArray( wrapEach );

	// TODO: check for and fix nesting validity like fixupInsertion does
	if ( range.start > unwrapOuter.length ) {
		// Retain up to the first thing we're unwrapping
		// The outer unwrapping takes place *outside*
		// the range, so compensate for that
		tx.pushRetain( range.start - unwrapOuter.length );
	} else if ( range.start < unwrapOuter.length ) {
		throw new Error( 'unwrapOuter is longer than the data preceding the range' );
	}

	// Replace the opening elements for the outer unwrap&wrap
	if ( wrapOuter.length > 0 || unwrapOuter.length > 0 ) {
		// Verify that wrapOuter matches the data at this position
		unwrapOuterData = doc.data.slice( range.start - unwrapOuter.length, range.start );
		for ( i = 0; i < unwrapOuterData.length; i++ ) {
			if ( unwrapOuterData[ i ].type !== unwrapOuter[ i ].type ) {
				throw new Error( 'Element in unwrapOuter does not match: expected ' +
					unwrapOuter[ i ].type + ' but found ' + unwrapOuterData[ i ].type );
			}
		}
		// Instead of putting in unwrapOuter as given, put it in the
		// way it appears in the model so we pick up any attributes
		tx.pushReplace( doc, range.start - unwrapOuter.length, unwrapOuter.length, ve.copy( wrapOuter ) );
	}

	if ( wrapEach.length > 0 || unwrapEach.length > 0 ) {
		// Visit each top-level child and wrap/unwrap it
		// TODO figure out if we should use the tree/node functions here
		// rather than iterating over offsets, it may or may not be faster
		for ( i = range.start; i < range.end; i++ ) {
			if ( doc.data.isElementData( i ) ) {
				// This is a structural offset
				if ( !doc.data.isCloseElementData( i ) ) {
					// This is an opening element
					if ( depth === 0 ) {
						// We are at the start of a top-level element
						// Replace the opening elements

						// Verify that unwrapEach matches the data at this position
						unwrapEachData = doc.data.slice( i, i + unwrapEach.length );
						for ( j = 0; j < unwrapEachData.length; j++ ) {
							if ( unwrapEachData[ j ].type !== unwrapEach[ j ].type ) {
								throw new Error( 'Element in unwrapEach does not match: expected ' +
									unwrapEach[ j ].type + ' but found ' +
									unwrapEachData[ j ].type );
							}
						}
						// Instead of putting in unwrapEach as given, put it in the
						// way it appears in the model, so we pick up any attributes
						tx.pushReplace( doc, i, unwrapEach.length, ve.copy( wrapEach ) );

						// Store this offset for later
						startOffset = i + unwrapEach.length;
					}
					depth++;
				} else {
					// This is a closing element
					depth--;
					if ( depth === 0 ) {
						// We are at the end of a top-level element
						// Advance past the element, then back up past the unwrapEach
						j = ( i + 1 ) - unwrapEach.length;
						// Retain the contents of what we're wrapping
						tx.pushRetain( j - startOffset );
						// Replace the closing elements
						tx.pushReplace( doc, j, unwrapEach.length, ve.copy( closingWrapEach ) );
					}
				}
			}
		}
	} else {
		// There is no wrapEach/unwrapEach to be done, just retain
		// up to the end of the range
		tx.pushRetain( range.end - range.start );
	}

	// this is a no-op if unwrapOuter.length===0 and wrapOuter.length===0
	tx.pushReplace( doc, range.end, unwrapOuter.length, closingArray( wrapOuter ) );

	// Retain up to the end of the document
	tx.pushFinalRetain( doc, range.end + unwrapOuter.length );

	return tx;
};

/**
 * Specification for how each type of operation should be reversed.
 *
 * This object maps operation types to objects, which map property names to reversal instructions.
 * A reversal instruction is either a string (which means the value of that property should be used)
 * or an object (which maps old values to new values). For instance, { from: 'to' }
 * means that the .from property of the reversed operation should be set to the .to property of the
 * original operation, and { method: { set: 'clear' } } means that if the .method property of
 * the original operation was 'set', the reversed operation's .method property should be 'clear'.
 *
 * If a property's treatment isn't specified, its value is simply copied without modification.
 * If an operation type's treatment isn't specified, all properties are copied without modification.
 *
 * @type {Object.<string,Object.<string,string|Object.<string, string>>>}
 */
ve.dm.Transaction.reversers = {
	annotate: { method: { set: 'clear', clear: 'set' } }, // swap 'set' with 'clear'
	attribute: { from: 'to', to: 'from' }, // swap .from with .to
	replace: { // swap .insert with .remove and .insertMetadata with .removeMetadata
		insert: 'remove',
		remove: 'insert',
		insertMetadata: 'removeMetadata',
		removeMetadata: 'insertMetadata'
	},
	replaceMetadata: { insert: 'remove', remove: 'insert' } // swap .insert with .remove
};

/**
 * Rebase parallel transactions transactionA and transactionB onto each other
 *
 * Recalling that a transaction is a mapping from one ve.dm.ElementLinearData state to another,
 * suppose we have two parallel transactions, i.e.:
 *
 * - transactionA mapping docstate0 to some docstateA, and
 * - transactionB mapping docstate0 to some docstateB .
 *
 * Then we want rebasing to give us two new transactions:
 *
 * - aRebasedOntoB mapping docstateB to some docstateC, and
 * - bRebasedOntoA mapping docstateA to docstateC ,
 *
 * so that applying transactionA then bRebasedOntoA results in the same document state as
 * applying transactionB then aRebasedOntoB .
 *
 * However, it is useful to regard some transaction pairs as "conflicting" or unrebasable. In
 * this implementation, transactions are considered to conflict if they have active ranges that
 * overlap, where a transaction's "active range" means the smallest single range in the *start*
 * document outside which the contents are unchanged by the transaction. (In practice the
 * operations within the transaction actually specify which ranges map to where, giving a
 * natural and unambiguous definition of "active range". Also, the identity transaction on a
 * document state has no active range but is trivially rebasable with any parallel
 * transaction).
 *
 * For non-conflicting transactions, rebasing of each transaction is performed by resizing the
 * inactive range either before or after the transaction to accommodate the length difference
 * caused by the other transaction. There is ambiguity in the case where both transactions have
 * a zero-length active range at the same position (i.e. two inserts in the same place); in this
 * case, transactionA's insertion is put before transactionB's.
 *
 * It is impossible for rebasing defined this way to create an invalid transaction that breaks
 * tree validity. This is clear because every position in the rebased transaction's active
 * range has the same node ancestry as the corresponding position before the rebase (else a
 * tag must have changed both before and after that position, contradicting the fact that the
 * transactions' active ranges do not overlap).
 *
 * Also it is clear that for a pair of non-conflicting parallel transactions, applying either
 * one followed by the other rebased will result in the same final document state, as required.
 *
 * @param {ve.dm.Transaction} transactionA Transaction A
 * @param {ve.dm.Transaction} transactionB Transaction B, with the same document start state
 * @return {Mixed[]} [ aRebasedOntoB, bRebasedOntoA ], or [ null, null ] if conflicting
 */
ve.dm.Transaction.rebaseTransactions = function ( transactionA, transactionB ) {
	var infoA, infoB;
	/**
	 * Calculate a transaction's active range and length change
	 *
	 * @param {ve.dm.Transaction} transaction The transaction
	 * @return {Object} Active range and length change
	 * @return {number|undefined} return.start Start offset of the active range
	 * @return {number|undefined} return.end End offset of the active range
	 * @return {number} return.diff Length change the transaction causes
	 */
	function getActiveRangeAndLengthDiff( transaction ) {
		var i, len, op, start, end, active,
			offset = 0,
			annotations = 0,
			diff = 0;

		for ( i = 0, len = transaction.operations.length; i < len; i++ ) {
			op = transaction.operations[ i ];
			if ( op.type === 'annotate' ) {
				annotations += ( op.bias === 'start' ? 1 : -1 );
				continue;
			}
			active = annotations > 0 || (
				op.type !== 'retain' && op.type !== 'retainMetadata'
			);
			// Place start marker
			if ( active && start === undefined ) {
				start = offset;
			}
			// adjust offset and diff
			if ( op.type === 'retain' ) {
				offset += op.length;
			} else if ( op.type === 'replace' ) {
				offset += op.remove.length;
				diff += op.insert.length - op.remove.length;
			}
			// Place/move end marker
			if ( op.type === 'attribute' || op.type === 'replaceMetadata' ) {
				// Op with length 0 but that effectively modifies 1 position
				end = offset + 1;
			} else if ( active ) {
				end = offset;
			}
		}
		return { start: start, end: end, diff: diff };
	}

	/**
	 * Adjust (in place) the retain length at the start/end of an operations list
	 *
	 * @param {Object[]} ops Operations list
	 * @param {string} place Where to adjust, start|end
	 * @param {number} diff Adjustment; must not cause negative retain length
	 */
	function adjustRetain( ops, place, diff ) {
		var start = place === 'start',
			i = start ? 0 : ops.length - 1;

		if ( diff === 0 ) {
			return;
		}
		if ( !start && ops[ i ] && ops[ i ].type === 'retainMetadata' ) {
			i = ops.length - 2;
		}
		if ( ops[ i ] && ops[ i ].type === 'retain' ) {
			ops[ i ].length += diff;
			if ( ops[ i ].length < 0 ) {
				throw new Error( 'Negative retain length' );
			} else if ( ops[ i ].length === 0 ) {
				ops.splice( i, 1 );
			}
			return;
		}
		if ( diff < 0 ) {
			throw new Error( 'Negative retain length' );
		}
		ops.splice( start ? 0 : ops.length, 0, { type: 'retain', length: diff } );
	}

	transactionA = transactionA.clone();
	transactionB = transactionB.clone();
	infoA = getActiveRangeAndLengthDiff( transactionA );
	infoB = getActiveRangeAndLengthDiff( transactionB );

	if ( infoA.start === undefined || infoB.start === undefined ) {
		// One of the transactions is a no-op: only need to adjust its retain length.
		// We can safely adjust both, because the no-op must have diff 0
		adjustRetain( transactionA.operations, 'start', infoB.diff );
		adjustRetain( transactionB.operations, 'start', infoA.diff );
	} else if ( infoA.end <= infoB.start ) {
		// This includes the case where both transactions are insertions at the same
		// point
		adjustRetain( transactionB.operations, 'start', infoA.diff );
		adjustRetain( transactionA.operations, 'end', infoB.diff );
	} else if ( infoB.end <= infoA.start ) {
		adjustRetain( transactionA.operations, 'start', infoB.diff );
		adjustRetain( transactionB.operations, 'end', infoA.diff );
	} else {
		// The active ranges overlap: conflict
		return [ null, null ];
	}
	return [ transactionA, transactionB ];
};

/* Methods */

/**
 * Get a serializable object describing the transaction
 *
 * @return {Object} Serializable object
 */
ve.dm.Transaction.prototype.toJSON = function () {
	return this.operations;
};

/**
 * Create a clone of this transaction.
 *
 * The returned transaction will be exactly the same as this one, except that its 'applied' flag
 * will be cleared. This means that if a transaction has already been committed, it will still
 * be possible to commit the clone. This is used for redoing transactions that were undone.
 *
 * @return {ve.dm.Transaction} Clone of this transaction
 */
ve.dm.Transaction.prototype.clone = function () {
	var tx = new this.constructor();
	tx.operations = ve.copy( this.operations );
	return tx;
};

/**
 * Create a reversed version of this transaction.
 *
 * The returned transaction will be the same as this one but with all operations reversed. This
 * means that applying the original transaction and then applying the reversed transaction will
 * result in no net changes. This is used to undo transactions.
 *
 * @return {ve.dm.Transaction} Reverse of this transaction
 */
ve.dm.Transaction.prototype.reversed = function () {
	var i, len, op, newOp, reverse, prop, tx = new this.constructor();
	for ( i = 0, len = this.operations.length; i < len; i++ ) {
		op = this.operations[ i ];
		newOp = ve.copy( op );
		reverse = this.constructor.reversers[ op.type ] || {};
		for ( prop in reverse ) {
			if ( typeof reverse[ prop ] === 'string' ) {
				newOp[ prop ] = op[ reverse[ prop ] ];
			} else {
				newOp[ prop ] = reverse[ prop ][ op[ prop ] ];
			}
		}
		tx.operations.push( newOp );
	}
	return tx;
};

/**
 * Check if the transaction would make any actual changes if processed.
 *
 * There may be more sophisticated checks that can be done, like looking for things being replaced
 * with identical content, but such transactions probably should not be created in the first place.
 *
 * @method
 * @return {boolean} Transaction is no-op
 */
ve.dm.Transaction.prototype.isNoOp = function () {
	if ( this.operations.length === 0 ) {
		return true;
	} else if ( this.operations.length === 1 ) {
		return this.operations[ 0 ].type === 'retain';
	} else if ( this.operations.length === 2 ) {
		return this.operations[ 0 ].type === 'retain' &&
			this.operations[ 1 ].type === 'retainMetadata';
	} else {
		return false;
	}
};

/**
 * Get all operations.
 *
 * @method
 * @return {Object[]} List of operations
 */
ve.dm.Transaction.prototype.getOperations = function () {
	return this.operations;
};

/**
 * Check if the transaction has any operations with a certain type.
 *
 * @method
 * @return {boolean} Has operations of a given type
 */
ve.dm.Transaction.prototype.hasOperationWithType = function ( type ) {
	var i, len;
	for ( i = 0, len = this.operations.length; i < len; i++ ) {
		if ( this.operations[ i ].type === type ) {
			return true;
		}
	}
	return false;
};

/**
 * Check if the transaction has any content data operations, such as insertion or deletion.
 *
 * @method
 * @return {boolean} Has content data operations
 */
ve.dm.Transaction.prototype.hasContentDataOperations = function () {
	return this.hasOperationWithType( 'replace' );
};

/**
 * Check if the transaction has any element attribute operations.
 *
 * @method
 * @return {boolean} Has element attribute operations
 */
ve.dm.Transaction.prototype.hasElementAttributeOperations = function () {
	return this.hasOperationWithType( 'attribute' );
};

/**
 * Check if the transaction has any annotation operations.
 *
 * @method
 * @return {boolean} Has annotation operations
 */
ve.dm.Transaction.prototype.hasAnnotationOperations = function () {
	return this.hasOperationWithType( 'annotate' );
};

/**
 * Check whether the transaction has already been applied.
 *
 * @method
 * @return {boolean}
 */
ve.dm.Transaction.prototype.hasBeenApplied = function () {
	return this.applied;
};

/**
 * Mark the transaction as having been applied.
 *
 * Should only be called after committing the transaction.
 *
 * @see ve.dm.Transaction#hasBeenApplied
 */
ve.dm.Transaction.prototype.markAsApplied = function () {
	this.applied = true;
};

/**
 * Translate an offset based on a transaction.
 *
 * This is useful when you want to anticipate what an offset will be after a transaction is
 * processed.
 *
 * @method
 * @param {number} offset Offset in the linear model before the transaction has been processed
 * @param {boolean} [excludeInsertion] Map the offset immediately before an insertion to
 *  right before the insertion rather than right after
 * @return {number} Translated offset, as it will be after processing transaction
 */
ve.dm.Transaction.prototype.translateOffset = function ( offset, excludeInsertion ) {
	var i, op, insertLength, removeLength, prevAdjustment,
		cursor = 0,
		adjustment = 0;

	for ( i = 0; i < this.operations.length; i++ ) {
		op = this.operations[ i ];
		if ( op.type === 'replace' ) {
			insertLength = op.insert.length;
			removeLength = op.remove.length;
			prevAdjustment = adjustment;
			adjustment += insertLength - removeLength;
			if ( offset === cursor + removeLength ) {
				// Offset points to right after the removal or right before the insertion
				if ( excludeInsertion && insertLength > removeLength ) {
					// Translate it to before the insertion
					return offset + adjustment - insertLength + removeLength;
				} else {
					// Translate it to after the removal/insertion
					return offset + adjustment;
				}
			} else if ( offset === cursor ) {
				// The offset points to right before the removal or replacement
				if ( insertLength === 0 ) {
					// Translate it to after the removal
					return cursor + removeLength + adjustment;
				} else {
					// Translate it to before the replacement
					// To translate this correctly, we have to use adjustment as it was before
					// we adjusted it for this replacement
					return cursor + prevAdjustment;
				}
			} else if ( offset > cursor && offset < cursor + removeLength ) {
				// The offset points inside of the removal
				// Translate it to after the removal
				return cursor + removeLength + adjustment;
			}
			cursor += removeLength;
		} else if ( op.type === 'retain' ) {
			if ( offset >= cursor && offset < cursor + op.length ) {
				return offset + adjustment;
			}
			cursor += op.length;
		}
	}
	return offset + adjustment;
};

/**
 * Translate a range based on a transaction.
 *
 * This is useful when you want to anticipate what a selection will be after a transaction is
 * processed.
 *
 * @method
 * @see #translateOffset
 * @param {ve.Range} range Range in the linear model before the transaction has been processed
 * @param {boolean} [excludeInsertion] Do not grow the range to cover insertions
 *  on the boundaries of the range.
 * @return {ve.Range} Translated range, as it will be after processing transaction
 */
ve.dm.Transaction.prototype.translateRange = function ( range, excludeInsertion ) {
	var start = this.translateOffset( range.start, !excludeInsertion ),
		end = this.translateOffset( range.end, excludeInsertion );
	return range.isBackwards() ? new ve.Range( end, start ) : new ve.Range( start, end );
};

/**
 * Get the range that covers modifications made by this transaction.
 *
 * In the case of insertions, the range covers content the user intended to insert.
 * It ignores wrappers added by ve.dm.Document#fixUpInsertion.
 *
 * The returned range is relative to the new state, after the transaction is applied. So for a
 * simple insertion transaction, the range will cover the newly inserted data, and for a simple
 * removal transaction it will be a zero-length range.
 *
 * Changes within the internal list at the end of a document are ignored.
 *
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @return {ve.Range|null} Range covering modifications, or null for a no-op transaction
 */
ve.dm.Transaction.prototype.getModifiedRange = function ( doc ) {
	var i, len, op, start, end,
		oldOffset = 0,
		offset = 0,
		internalListNode = doc.getInternalList().getListNode(),
		docEndOffset = internalListNode ? internalListNode.getOuterRange().start : this.getDocument().data.getLength();

	opLoop:
	for ( i = 0, len = this.operations.length; i < len; i++ ) {
		op = this.operations[ i ];
		switch ( op.type ) {
			case 'retainMetadata':
				continue;

			case 'retain':
				if ( oldOffset + op.length > docEndOffset ) {
					break opLoop;
				}
				offset += op.length;
				oldOffset += op.length;
				break;

			default:
				if ( start === undefined ) {
					// This is the first non-retain operation, set start to right before it
					start = offset + ( op.insertedDataOffset || 0 );
				}
				if ( op.type === 'replace' ) {
					offset += op.insert.length;
					oldOffset += op.remove.length;
				}
				// Set end, so it'll end up being right after the last non-retain operation
				if ( op.insertedDataLength ) {
					end = start + op.insertedDataLength;
				} else {
					end = offset;
				}
				break;
		}
	}
	if ( start === undefined || end === undefined ) {
		// No-op transaction
		return null;
	}
	return new ve.Range( start, end );
};

/**
 * Add a final retain operation to finish off a transaction (internal helper).
 *
 * @private
 * @method
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @param {number} offset Final offset edited by the transaction up to this point.
 * @param {number} [metaOffset=0] Final metadata offset edited, if non-zero.
 */
ve.dm.Transaction.prototype.pushFinalRetain = function ( doc, offset, metaOffset ) {
	var data = doc.data,
		metadata = doc.metadata,
		finalMetadata = metadata.getData( data.getLength() );
	if ( offset < doc.data.getLength() ) {
		this.pushRetain( doc.data.getLength() - offset );
		metaOffset = 0;
	}
	// if there is trailing metadata, push a final retainMetadata
	if ( finalMetadata !== undefined && finalMetadata.length > 0 ) {
		this.pushRetainMetadata( finalMetadata.length - ( metaOffset || 0 ) );
	}
};

/**
 * Add a retain operation.
 *
 * @method
 * @param {number} length Length of content data to retain
 * @throws {Error} Cannot retain backwards
 */
ve.dm.Transaction.prototype.pushRetain = function ( length ) {
	var end;
	if ( length < 0 ) {
		throw new Error( 'Invalid retain length, cannot retain backwards:' + length );
	}
	if ( length ) {
		end = this.operations.length - 1;
		if ( this.operations.length && this.operations[ end ].type === 'retain' ) {
			this.operations[ end ].length += length;
		} else {
			this.operations.push( {
				type: 'retain',
				length: length
			} );
		}
	}
};

/**
 * Add a retain metadata operation.
 * // TODO: this is a copy/paste of pushRetain (at the moment). Consider a refactor.
 *
 * @method
 * @param {number} length Length of content data to retain
 * @throws {Error} Cannot retain backwards
 */
ve.dm.Transaction.prototype.pushRetainMetadata = function ( length ) {
	var end;
	if ( length < 0 ) {
		throw new Error( 'Invalid retain length, cannot retain backwards:' + length );
	}
	if ( length ) {
		end = this.operations.length - 1;
		if ( this.operations.length && this.operations[ end ].type === 'retainMetadata' ) {
			this.operations[ end ].length += length;
		} else {
			this.operations.push( {
				type: 'retainMetadata',
				length: length
			} );
		}
	}
};

/**
 * Adds a replace op to remove the desired range and, where required, splices in retain ops
 * to prevent the deletion of undeletable nodes.
 *
 * An extra `replaceMetadata` operation might be pushed at the end if the
 * affected region contains metadata; see
 * {@link ve.dm.Transaction#pushReplace} for details.
 *
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @param {number} removeStart Offset to start removing from
 * @param {number} removeEnd Offset to remove to
 * @param {boolean} [removeMetadata=false] Remove metadata instead of collapsing it
 * @return {number} End offset of the removal
 */
ve.dm.Transaction.prototype.addSafeRemoveOps = function ( doc, removeStart, removeEnd, removeMetadata ) {
	var i, queuedRetain,
		retainStart = removeStart,
		undeletableStackDepth = 0;
	// Iterate over removal range and use a stack counter to determine if
	// we are inside an undeletable node
	for ( i = removeStart; i < removeEnd; i++ ) {
		if ( doc.data.isElementData( i ) && !ve.dm.nodeFactory.isNodeDeletable( doc.data.getType( i ) ) ) {
			if ( !doc.data.isCloseElementData( i ) ) {
				if ( undeletableStackDepth === 0 ) {
					if ( queuedRetain ) {
						this.pushRetain( queuedRetain );
					}
					this.pushReplace( doc, removeStart, i - removeStart, [], removeMetadata ? [] : undefined );
					retainStart = i;
				}
				undeletableStackDepth++;
			} else {
				undeletableStackDepth--;
				if ( undeletableStackDepth === 0 ) {
					queuedRetain = i + 1 - retainStart;
					removeStart = i + 1;
				}
			}
		}
	}
	if ( removeEnd - removeStart ) {
		if ( queuedRetain ) {
			this.pushRetain( queuedRetain );
		}
		this.pushReplace( doc, removeStart, removeEnd - removeStart, [], removeMetadata ? [] : undefined );
		retainStart = removeEnd;
	}
	return retainStart;
};

/**
 * Add a replace operation (internal helper).
 *
 * @private
 * @method
 * @param {Array} remove Data removed.
 * @param {Array} insert Data to insert.
 * @param {Array|undefined} removeMetadata Metadata removed.
 * @param {Array} insertMetadata Metadata to insert.
 */
ve.dm.Transaction.prototype.pushReplaceInternal = function ( remove, insert, removeMetadata, insertMetadata, insertedDataOffset, insertedDataLength ) {
	var op = {
		type: 'replace',
		remove: remove,
		insert: insert
	};
	if ( remove.length === 0 && insert.length === 0 ) {
		return; // no-op
	}
	if ( removeMetadata !== undefined && insertMetadata !== undefined ) {
		op.removeMetadata = removeMetadata;
		op.insertMetadata = insertMetadata;
	}
	if ( insertedDataOffset !== undefined && insertedDataLength !== undefined ) {
		op.insertedDataOffset = insertedDataOffset;
		op.insertedDataLength = insertedDataLength;
	}
	this.operations.push( op );
};

/**
 * Add a replace operation, keeping metadata in sync if required.
 *
 * Note that metadata attached to removed content is moved so that it
 * attaches just before the inserted content.  If there is
 * metadata attached to the removed content but there is no inserted
 * content, then an extra `replaceMetadata` operation is pushed in order
 * to properly insert the merged metadata before the character immediately
 * after the removed content. (Note that there is an extra metadata element
 * after the final data element; if the removed region is at the very end of
 * the document, the inserted `replaceMetadata` operation targets this
 * final metadata element.)
 *
 * @method
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @param {number} offset Offset to start at
 * @param {number} removeLength Number of data items to remove
 * @param {Array} insert Data to insert
 * @param {Array} [insertMetadata] Overwrite the metadata with this data, rather than collapsing it
 * @param {number} [insertedDataOffset] Offset of the originally inserted data in the resulting operation data
 * @param {number} [insertedDataLength] Length of the originally inserted data in the resulting operation data
 */
ve.dm.Transaction.prototype.pushReplace = function ( doc, offset, removeLength, insert, insertMetadata, insertedDataOffset, insertedDataLength ) {
	var extraMetadata, end, lastOp, penultOp, range, remove, removeMetadata,
		isRemoveEmpty, isInsertEmpty, mergedMetadata;

	if ( removeLength === 0 && insert.length === 0 ) {
		// Don't push no-ops
		return;
	}

	end = this.operations.length - 1;
	lastOp = end >= 0 ? this.operations[ end ] : null;
	penultOp = end >= 1 ? this.operations[ end - 1 ] : null;
	range = new ve.Range( offset, offset + removeLength );
	remove = doc.getData( range );
	removeMetadata = doc.getMetadata( range );
	// ve.compare compares arrays as objects, so no need to check against
	// an array of the same length for emptiness.
	isRemoveEmpty = ve.compare( removeMetadata, [] );
	isInsertEmpty = insertMetadata && ve.compare( insertMetadata, [] );
	mergedMetadata = [];

	if ( !insertMetadata && !isRemoveEmpty ) {
		// if we are removing a range which includes metadata, we need to
		// collapse it.  If there's nothing to insert, we also need to add
		// an extra `replaceMetadata` operation later in order to insert the
		// collapsed metadata.
		insertMetadata = ve.dm.MetaLinearData.static.merge( removeMetadata );
		if ( insert.length === 0 ) {
			extraMetadata = insertMetadata[ 0 ];
			insertMetadata = [];
		} else {
			// pad out at end so insert metadata is the same length as insert data
			ve.batchSplice( insertMetadata, 1, 0, new Array( insert.length - 1 ) );
		}
		isInsertEmpty = ve.compare( insertMetadata, new Array( insertMetadata.length ) );
	} else if ( isInsertEmpty && isRemoveEmpty ) {
		// No metadata changes, don't pollute the transaction with [undefined, undefined, ...]
		insertMetadata = undefined;
	}

	// simple replaces can be combined
	// (but don't do this if there is metadata to be removed and the previous
	// replace had a non-zero insertion, because that would shift the metadata
	// location.  also skip this if the last replace deliberately removed
	// metadata instead of merging it.)
	if (
		lastOp && lastOp.type === 'replaceMetadata' &&
		lastOp.insert.length > 0 && lastOp.remove.length === 0 &&
		penultOp && penultOp.type === 'replace' &&
		penultOp.insert.length === 0 /* this is always true */
	) {
		mergedMetadata = [ lastOp.insert ];
		this.operations.pop();
		lastOp = penultOp;
		/* fall through */
	}
	// merge, where extraMetadata will not be required
	if (
		lastOp && lastOp.type === 'replace' &&
		!( lastOp.insert.length > 0 && insertMetadata !== undefined ) &&
		lastOp.insertedDataOffset === undefined && !extraMetadata &&
		// don't merge if we mergedMetadata and had to insert non-empty
		// metadata as a result
		!( mergedMetadata.length > 0 && insertMetadata !== undefined && !isInsertEmpty )
	) {
		lastOp = this.operations.pop();
		this.pushReplace(
			doc,
			offset - lastOp.remove.length,
			lastOp.remove.length + removeLength,
			lastOp.insert.concat( insert ),
			(
				lastOp.insertMetadata || new Array( lastOp.insert.length )
			).concat(
				mergedMetadata
			).concat(
				( insertMetadata === undefined || isInsertEmpty ) ?
				new Array( insert.length - mergedMetadata.length ) :
				insertMetadata
			),
			insertedDataOffset,
			insertedDataLength
		);
		return;
	}
	// merge a "remove after remove" (where extraMetadata will be required)
	if (
		lastOp && lastOp.type === 'replace' &&
		lastOp.insert.length === 0 && insert.length === 0 &&
		( lastOp.removeMetadata === undefined || mergedMetadata.length > 0 ) &&
		( insertMetadata === undefined || extraMetadata )
	) {
		lastOp = this.operations.pop();
		this.pushReplace(
			doc,
			offset - lastOp.remove.length,
			lastOp.remove.length + removeLength,
			[]
		);
		return;
	}

	if ( lastOp && lastOp.type === 'replaceMetadata' ) {
		// `replace` operates on the metadata at the given offset; the transaction
		// touches the same region twice if `replace` follows a `replaceMetadata`
		// without a `retain` in between.
		throw new Error( 'replace after replaceMetadata not allowed' );
	}

	this.pushReplaceInternal( remove, insert, removeMetadata, insertMetadata, insertedDataOffset, insertedDataLength );

	if ( extraMetadata !== undefined ) {
		this.pushReplaceMetadata( [], extraMetadata );
	}
};

/**
 * Add a replace metadata operation
 *
 * @method
 * @param {Array} remove Metadata to remove
 * @param {Array} insert Metadata to replace 'remove' with
 */
ve.dm.Transaction.prototype.pushReplaceMetadata = function ( remove, insert ) {
	if ( remove.length === 0 && insert.length === 0 ) {
		// Don't push no-ops
		return;
	}
	this.operations.push( {
		type: 'replaceMetadata',
		remove: remove,
		insert: insert
	} );
};

/**
 * Add an element attribute change operation.
 *
 * @method
 * @param {string} key Name of attribute to change
 * @param {Mixed} from Value change attribute from, or undefined if not previously set
 * @param {Mixed} to Value to change attribute to, or undefined to remove
 */
ve.dm.Transaction.prototype.pushReplaceElementAttribute = function ( key, from, to ) {
	this.operations.push( {
		type: 'attribute',
		key: key,
		from: from,
		to: to
	} );
};

/**
 * Add a series of element attribute change operations.
 *
 * @param {Object} changes Object mapping attribute names to new values
 * @param {Object} oldAttrs Object mapping attribute names to old values
 */
ve.dm.Transaction.prototype.pushAttributeChanges = function ( changes, oldAttrs ) {
	var key;
	for ( key in changes ) {
		if ( oldAttrs[ key ] !== changes[ key ] ) {
			this.pushReplaceElementAttribute( key, oldAttrs[ key ], changes[ key ] );
		}
	}
};

/**
 * Add a start annotating operation.
 *
 * @method
 * @param {string} method Method to use, either "set" or "clear"
 * @param {Object} index Store index of annotation object to start setting or clearing from content data
 */
ve.dm.Transaction.prototype.pushStartAnnotating = function ( method, index ) {
	this.operations.push( {
		type: 'annotate',
		method: method,
		bias: 'start',
		index: index
	} );
};

/**
 * Add a stop annotating operation.
 *
 * @method
 * @param {string} method Method to use, either "set" or "clear"
 * @param {Object} index Store index of annotation object to stop setting or clearing from content data
 */
ve.dm.Transaction.prototype.pushStopAnnotating = function ( method, index ) {
	this.operations.push( {
		type: 'annotate',
		method: method,
		bias: 'stop',
		index: index
	} );
};

/**
 * Internal helper method for newFromInsertion and newFromReplacement.
 * Adds an insertion to an existing transaction object.
 *
 * @private
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @param {number} currentOffset Offset up to which the transaction has gone already
 * @param {number} insertOffset Offset to insert at
 * @param {Array} data Linear model data to insert
 * @return {number} End offset of the insertion
 */
ve.dm.Transaction.prototype.pushInsertion = function ( doc, currentOffset, insertOffset, data ) {
	// Fix up the insertion
	var insertion = doc.fixupInsertion( data, insertOffset );
	// Retain up to insertion point, if needed
	this.pushRetain( insertion.offset - currentOffset );
	// Insert data
	this.pushReplace(
		doc, insertion.offset, insertion.remove, insertion.data, undefined,
		insertion.insertedDataOffset, insertion.insertedDataLength
	);
	return insertion.offset + insertion.remove;
};

/**
 * Internal helper method for newFromRemoval and newFromReplacement.
 * Adds a removal to an existing transaction object.
 *
 * @private
 * @param {ve.dm.Document} doc The document in the state to which the transaction applies
 * @param {number} currentOffset Offset up to which the transaction has gone already
 * @param {ve.Range} range Range to remove
 * @param {boolean} [removeMetadata=false] Remove metadata instead of collapsing it
 * @return {number} End offset of the removal
 */
ve.dm.Transaction.prototype.pushRemoval = function ( doc, currentOffset, range, removeMetadata ) {
	var i, selection, first, last, nodeStart, nodeEnd,
		offset = currentOffset,
		removeStart = null,
		removeEnd = null;
	// Validate range
	if ( range.isCollapsed() ) {
		// Empty range, nothing to remove
		this.pushRetain( range.start - currentOffset );
		return range.start;
	}
	// Select nodes and validate selection
	selection = doc.selectNodes( range, 'covered' );
	if ( selection.length === 0 ) {
		// Empty selection? Something is wrong!
		throw new Error( 'Invalid range, cannot remove from ' + range.start + ' to ' + range.end );
	}
	first = selection[ 0 ];
	last = selection[ selection.length - 1 ];
	// If the first and last node are mergeable, merge them
	if ( first.node.canBeMergedWith( last.node ) ) {
		if ( !first.range && !last.range ) {
			// First and last node are both completely covered, remove them
			removeStart = first.nodeOuterRange.start;
			removeEnd = last.nodeOuterRange.end;
		} else {
			// Either the first node or the last node is partially covered, so remove
			// the selected content. The other node might be fully covered, in which case
			// we remove its contents (nodeRange). For fully covered content nodes, we must
			// remove the entire node (nodeOuterRange).
			removeStart = (
				first.range ||
				( first.node.isContent() ? first.nodeOuterRange : first.nodeRange )
			).start;
			removeEnd = (
				last.range ||
				( last.node.isContent() ? last.nodeOuterRange : last.nodeRange )
			).end;
		}
		this.pushRetain( removeStart - currentOffset );
		removeEnd = this.addSafeRemoveOps( doc, removeStart, removeEnd, removeMetadata );
		// All done
		return removeEnd;
	}

	// The selection wasn't mergeable, so remove nodes that are completely covered, and strip
	// nodes that aren't
	for ( i = 0; i < selection.length; i++ ) {
		if ( !selection[ i ].range ) {
			// Entire node is covered, remove it
			nodeStart = selection[ i ].nodeOuterRange.start;
			nodeEnd = selection[ i ].nodeOuterRange.end;
		} else {
			// Part of the node is covered, remove that range
			nodeStart = selection[ i ].range.start;
			nodeEnd = selection[ i ].range.end;
		}

		// Merge contiguous removals. Only apply a removal when a gap appears, or at the
		// end of the loop
		if ( removeEnd === null ) {
			// First removal
			removeStart = nodeStart;
			removeEnd = nodeEnd;
		} else if ( removeEnd === nodeStart ) {
			// Merge this removal into the previous one
			removeEnd = nodeEnd;
		} else {
			// There is a gap between the previous removal and this one

			// Push the previous removal first
			this.pushRetain( removeStart - offset );
			offset = this.addSafeRemoveOps( doc, removeStart, removeEnd, removeMetadata );

			// Now start this removal
			removeStart = nodeStart;
			removeEnd = nodeEnd;
		}
	}
	// Apply the last removal, if any
	if ( removeEnd !== null ) {
		this.pushRetain( removeStart - offset );
		offset = this.addSafeRemoveOps( doc, removeStart, removeEnd, removeMetadata );
	}
	return offset;
};

/**
 * Rebase this transaction to be applicable after another one
 *
 * The returned transaction is equivalent to this, but with operation ranges remapped in
 * accordance with the length changes made by other. If operations overlap with those in other,
 * then a conflict is signalled by returning null.
 *
 * @param {ve.dm.Transaction} other Transaction acting on the same document state as this
 * @param {boolean} [startmost] If ambiguous, operations from this come startmost (default: endmost)
 * @return {ve.dm.Transaction|null} Rebased transaction, or null if changed ranges conflict
 */
ve.dm.Transaction.prototype.rebasedOnto = function ( other, startmost ) {
	if ( startmost ) {
		return this.constructor.rebaseTransactions( this, other )[ 0 ];
	} else {
		return this.constructor.rebaseTransactions( other, this )[ 1 ];
	}
};
