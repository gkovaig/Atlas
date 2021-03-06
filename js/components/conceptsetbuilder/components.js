define(function (require, exports) {
	
	var ko = require('knockout')
	
	var conceptSetBuilder = require('./components/ConceptSetBuilder');
	
	var includedConcepts = require('./components/IncludedConcepts');
	ko.components.register('concept-set-included-concepts', includedConcepts);	

	var mappedConcepts = require('./components/MappedConcepts');
	ko.components.register('concept-set-mapped-concepts', mappedConcepts);	
	
});