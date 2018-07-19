define(['knockout', 'text!./cohort-definition-manager.html',
	'appConfig',
	'cohortbuilder/CohortDefinition',
	'webapi/CohortDefinitionAPI',
	'webapi/MomentAPI',
	'webapi/ConceptSetAPI',
	'ohdsi.util',
	'components/conceptset/utils',
	'cohortbuilder/CohortExpression',
	'cohortbuilder/InclusionRule',
	'conceptsetbuilder/InputTypes/ConceptSet',
	'webapi/CohortReportingAPI',
	'vocabularyprovider',
	'atlas-state',
	'clipboard',
	'd3',
	'job/jobDetail',
	'components/cohort-definitions/const',
	'webapi/ConceptSetAPI',
	'services/ConceptSetService',
	'cohortbuilder/components/FeasibilityReportViewer',
	'databindings',
	'faceted-datatable',
	'cohortdefinitionviewer/expressionCartoonBinding',
	'cohortfeatures',
	'conceptset-modal',
	'css!./cohort-definition-manager.css',
    'components/modal-pick-options'
], function (ko, view, config, CohortDefinition, cohortDefinitionAPI, momentApi, conceptSetApi, util, conceptSetUitls, CohortExpression, InclusionRule, ConceptSet, cohortReportingAPI, vocabularyApi, sharedState, clipboard, d3, jobDetail, cohortConst, conceptSetAPI, conceptSetService) {

	function translateSql(sql, dialect) {
		translatePromise = $.ajax({
			url: config.webAPIRoot + 'sqlrender/translate',
			method: 'POST',
			contentType: 'application/json',
			data: JSON.stringify({
				SQL: sql,
				targetdialect: dialect
			}),
			error: function (error) {
				console.log("Error: " + error);
			}
		});
		return translatePromise;
	}

	function pruneJSON(key, value) {
		if (value === 0 || value) {
			return value;
		} else {
			return
		}
	}

	function conceptSetSorter(a, b) {
		var textA = a.name().toUpperCase();
		var textB = b.name().toUpperCase();
		return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
	}

	function cohortDefinitionManager(params) {
		var self = this;
		var pollTimeout = null;
		var authApi = params.model.authApi;
		self.config = config;
		self.selectedConcepts = sharedState.selectedConcepts;
		self.model = params.model;

		self.cohortDefinitionCaption = ko.computed(function () {
			if (self.model.currentCohortDefinition()) {
				if (self.model.currentCohortDefinition().id() == 0) {
					return 'New Cohort';
				} else {
					return 'Cohort #' + self.model.currentCohortDefinition().id();
				}
			}
		});
		self.isAuthenticated = ko.pureComputed(function () {
			return authApi.isAuthenticated();
		});
		var isNew = ko.pureComputed(function () {
			return !self.model.currentCohortDefinition() || (self.model.currentCohortDefinition().id() == 0);
		});
		self.canEdit = self.model.canEditCurrentCohortDefinition;
		self.canCopy = ko.pureComputed(function () {
			return !isNew() && (self.isAuthenticated() && authApi.isPermittedCopyCohort(self.model.currentCohortDefinition().id()) || !config.userAuthenticationEnabled);
		});
		self.canDelete = ko.pureComputed(function () {
			if (isNew()) {
				return false;
			}

			return ((self.isAuthenticated() && authApi.isPermittedDeleteCohort(self.model.currentCohortDefinition().id()) || !config.userAuthenticationEnabled));
		});
		self.hasAccess = ko.pureComputed(function () {

			if (!config.userAuthenticationEnabled) {
				return true;
			}

			if (!self.isAuthenticated()) {
				return false;
			}

			if (isNew()) {
				return authApi.isPermittedCreateCohort();
			}

			return authApi.isPermittedReadCohort(self.model.currentCohortDefinition().id());
		});
		
		self.hasAccessToGenerate = function (sourceKey) {
			if (isNew()) {
				return false;
			}

			return authApi.isPermittedGenerateCohort(self.model.currentCohortDefinition().id(), sourceKey);
		}
		self.hasAccessToReadCohortReport = function (sourceKey) {
			if (isNew()) {
				return false;
			}

			return self.isAuthenticated() && authApi.isPermittedReadCohortReport(self.model.currentCohortDefinition().id(), sourceKey);
		}
		if (!self.hasAccess()) return;

		self.generatedSql = {};
		self.generatedSql.mssql = ko.observable('');
		self.generatedSql.oracle = ko.observable('');
		self.generatedSql.postgresql = ko.observable('');
		self.generatedSql.redshift = ko.observable('');
		self.generatedSql.msaps = ko.observable('');
		self.generatedSql.impala = ko.observable('');
		self.generatedSql.netezza = ko.observable('');
		self.templateSql = ko.observable('');
		self.tabMode = self.model.currentCohortDefinitionMode;
		self.cohortConst = cohortConst;
		self.generationTabMode = ko.observable("inclusion")
		self.exportTabMode = ko.observable('printfriendly');
    self.importTabMode = ko.observable(cohortConst.importTabModes.identifiers);
		self.exportSqlMode = ko.observable('ohdsisql');
		self.importConceptSetJson = ko.observable();
		self.conceptSetTabMode = self.model.currentConceptSetMode;
		self.showImportConceptSetModal = ko.observable(false);
		self.dirtyFlag = self.model.currentCohortDefinitionDirtyFlag;
		self.isLoadingSql = ko.observable(false);
		self.sharedState = sharedState;
		self.identifiers = ko.observable();
		self.sourcecodes = ko.observable();
		self.isSaveable = ko.pureComputed(function () {
			return self.dirtyFlag() && self.dirtyFlag().isDirty();
		});
		self.conceptLoading = ko.observable(false);
		self.conceptSetName = ko.observable();
		self.tabPath = ko.computed(function () {
			var path = self.tabMode();
			if (path === 'export') {
				path += '/' + self.exportTabMode();
			}
			if (self.exportTabMode() === 'cartoon') {
				setTimeout(function () {
					self.delayedCartoonUpdate('ready');
				}, 10);
			}
			return path;
		});
    self.canSave = ko.pureComputed(function(){
      return self.dirtyFlag().isDirty() && !self.isRunning() && self.canEdit();
    });

		self.delayedCartoonUpdate = ko.observable(null);

		self.saveConceptSetShow = ko.observable(false);
		self.newConceptSetName = ko.observable();

		self.canGenerate = ko.pureComputed(function () {
			var isDirty = self.dirtyFlag() && self.dirtyFlag().isDirty();
			var isNew = self.model.currentCohortDefinition() && (self.model.currentCohortDefinition().id() == 0);
			var canGenerate = !(isDirty || isNew);
			return (canGenerate);
		});


		self.modifiedJSON = "";
		self.expressionJSON = ko.pureComputed({
			read: function () {
				return ko.toJSON(self.model.currentCohortDefinition().expression(), function (key, value) {
					if (value === 0 || value) {
						return value;
					} else {
						return
					}
				}, 2);
			},
			write: function (value) {
				self.modifiedJSON = value;
			}
		});

		self.selectedSource = ko.observable();
		self.selectedReport = ko.observable();
		self.selectedReportCaption = ko.observable();
		self.selectedSourceKey = ko.pureComputed(() => self.selectedSource().sourceKey);
		self.loadingReport = ko.observable(false);
		self.sortedConceptSets = ko.computed(function (d) {
			if (self.model.currentCohortDefinition() != null) {
				var clone = self.model.currentCohortDefinition().expression().ConceptSets().slice(0);
				return clone.sort(conceptSetSorter);
			}
		});

		// model behaviors
		self.onConceptSetTabRespositoryConceptSetSelected = function (conceptSet) {
			self.model.loadConceptSet(conceptSet.id, 'cohort-definition-manager', 'cohort', 'details');
		}

		self.includedConceptsColumns = [{
			title: '<i class="fa fa-shopping-cart"></i>',
			render: function (s, p, d) {
				var css = '';
				var icon = 'fa-shopping-cart';
				if (sharedState.selectedConceptsIndex[d.CONCEPT_ID] == 1) {
					css = ' selected';
				}
				return '<i class="fa ' + icon + ' ' + css + '"></i>';
			},
			orderable: false,
			searchable: false
		}, {
			title: 'Id',
			data: 'CONCEPT_ID'
		}, {
			title: 'Code',
			data: 'CONCEPT_CODE'
		}, {
			title: 'Name',
			data: 'CONCEPT_NAME',
			render: function (s, p, d) {
				var valid = d.INVALID_REASON_CAPTION == 'Invalid' ? 'invalid' : '';
				return '<a class="' + valid + '" href=\"#/concept/' + d.CONCEPT_ID + '\">' + d.CONCEPT_NAME + '</a>';
			}
		}, {
			title: 'Class',
			data: 'CONCEPT_CLASS_ID'
		}, {
			title: 'Standard Concept Caption',
			data: 'STANDARD_CONCEPT_CAPTION',
			visible: false
		}, {
			title: 'RC',
			data: 'RECORD_COUNT',
			className: 'numeric'
		}, {
			title: 'DRC',
			data: 'DESCENDANT_RECORD_COUNT',
			className: 'numeric'
		}, {
			title: 'Domain',
			data: 'DOMAIN_ID'
		}, {
			title: 'Vocabulary',
			data: 'VOCABULARY_ID'
		}, {
			title: 'Ancestors',
			data: 'ANCESTORS',
			render: conceptSetService.getAncestorsRenderFunction()
		}];

		self.ancestors = ko.observableArray();
		self.ancestorsModalIsShown = ko.observable(false);
		self.showAncestorsModal = conceptSetService.getAncestorsModalHandler({
			includedConcepts: self.model.includedConcepts,
			ancestors: self.ancestors,
			ancestorsModalIsShown: self.ancestorsModalIsShown,
		});
		self.includedDrawCallback = conceptSetService.getIncludedConceptSetDrawCallback({ ...self, searchConceptsColumns: self.includedConceptsColumns });
		
		self.includedConceptsOptions = {
			Facets: [{
				'caption': 'Vocabulary',
				'binding': function (o) {
					return o.VOCABULARY_ID;
				}
			}, {
				'caption': 'Class',
				'binding': function (o) {
					return o.CONCEPT_CLASS_ID;
				}
			}, {
				'caption': 'Domain',
				'binding': function (o) {
					return o.DOMAIN_ID;
				}
			}, {
				'caption': 'Standard Concept',
				'binding': function (o) {
					return o.STANDARD_CONCEPT_CAPTION;
				}
			}, {
				'caption': 'Invalid Reason',
				'binding': function (o) {
					return o.INVALID_REASON_CAPTION;
				}
			}, {
				'caption': 'Has Records',
				'binding': function (o) {
					return parseInt(o.RECORD_COUNT.toString().replace(',', '')) > 0;
				}
			}, {
				'caption': 'Has Descendant Records',
				'binding': function (o) {
					return parseInt(o.DESCENDANT_RECORD_COUNT.toString().replace(',', '')) > 0;
				}
			}]
		};

		self.stopping = self.model.cohortDefinitionSourceInfo().reduce((acc, target) => ({...acc, [target.sourceKey]: ko.observable(false)}), {});
		self.isSourceStopping = (source) => self.stopping[source.sourceKey];

		self.pollForInfo = function () {
			if (pollTimeout)
				clearTimeout(pollTimeout);

			var id = pageModel.currentCohortDefinition().id();
			cohortDefinitionAPI.getInfo(id).then(function (infoList) {
				var hasPending = false;

				infoList.forEach(function (info) {
					// obtain source reference
					var source = self.model.cohortDefinitionSourceInfo().filter(function (cdsi) {
						var sourceId = sharedState.sources().find(source => source.sourceKey == cdsi.sourceKey).sourceId;
						return sourceId === info.id.sourceId;
					})[0];

					if (source) {
						// only bother updating those sources that we know are running
						if (self.isSourceRunning(source)) {
							source.status(info.status);
							source.includeFeatures(info.includeFeatures);
							source.isValid(info.isValid);
							source.startTime(momentApi.formatDateTime(new Date(info.startTime)));
							source.executionDuration('...');
							source.personCount('...');
							source.recordCount('...');

							if (info.status != "COMPLETE" && info.status != "FAILED") {
								hasPending = true;
								if (self.selectedSource() && source.sourceId === self.selectedSource().sourceId) {
									self.loadingReport(true);
								}
							} else {
								if (self.selectedSource() && source.sourceId === self.selectedSource().sourceId) {
									self.loadingReport(false);
									self.selectViewReport(source);
								}
								var commaFormatted = d3.format(",");
								source.executionDuration(momentApi.formatDuration(info.executionDuration));
								source.personCount(commaFormatted(info.personCount));
								source.recordCount(commaFormatted(info.recordCount));
								source.failMessage(info.failMessage);
							}
						}
					}
				});

				if (hasPending) {
					pollTimeout = setTimeout(function () {
						self.pollForInfo();
					}, 1000);
				}
			});
		}

		self.delete = function () {
			if (!confirm("Delete cohort definition? Warning: deletion can not be undone!"))
				return;

			clearTimeout(pollTimeout);

			// reset view after save
			cohortDefinitionAPI.deleteCohortDefinition(self.model.currentCohortDefinition().id()).then(function (result) {
				self.model.currentCohortDefinition(null);
				document.location = "#/cohortdefinitions"
			});
		}

		self.save = function () {
			clearTimeout(pollTimeout);
			self.model.clearConceptSet();

			// If we are saving a new cohort definition (id ==0) then clear
			// the id field before saving
			if (self.model.currentCohortDefinition().id() == 0) {
				self.model.currentCohortDefinition().id(undefined);
			}

			var definition = ko.toJS(self.model.currentCohortDefinition());

			// for saving, we flatten the expresson JS into a JSON string
			definition.expression = ko.toJSON(definition.expression, pruneJSON);

			// reset view after save
			cohortDefinitionAPI.saveCohortDefinition(definition).then(function (result) {
				result.expression = JSON.parse(result.expression);
				var definition = new CohortDefinition(result);
				var redirectWhenComplete = definition.id() != self.model.currentCohortDefinition().id();
				self.model.currentCohortDefinition(definition);
				if (redirectWhenComplete) {
					document.location = "#/cohortdefinition/" + definition.id();
				}
			});
		}

		self.close = function () {
			if (self.model.currentCohortDefinitionDirtyFlag().isDirty() && !confirm("Your cohort changes are not saved. Would you like to continue?")) {
				return;
			} else {
				document.location = "#/cohortdefinitions"
				self.model.currentConceptSet(null);
				self.model.currentConceptSetDirtyFlag.reset();
				self.model.currentCohortDefinition(null);
				self.model.currentCohortDefinitionDirtyFlag().reset();
				self.model.reportCohortDefinitionId(null);
				self.model.reportReportName(null);
				self.model.reportSourceKey(null);
			}
		}

		self.copy = function () {
			clearTimeout(pollTimeout);

			// reset view after save
			cohortDefinitionAPI.copyCohortDefinition(self.model.currentCohortDefinition().id()).then(function (result) {
				document.location = "#/cohortdefinition/" + result.id;
			});
		}

		self.isRunning = ko.pureComputed(function () {
			return self.model.cohortDefinitionSourceInfo().filter(function (info) {
				return !(info.status() == "COMPLETE" || info.status() == "n/a");
			}).length > 0;
		});

		self.isSourceRunning = function (source) {
			if (source) {
				switch (source.status()) {
					case 'COMPLETE':
						return false;
						break;
					case 'n/a':
						return false;
						break;
					default:
						return true;
				}
			} else {
				return false;
			}
		}

		self.showSql = function () {
			self.isLoadingSql(true);

			self.templateSql('');
			self.generatedSql.mssql('');
			self.generatedSql.oracle('');
			self.generatedSql.postgresql('');
			self.generatedSql.redshift('');
			self.generatedSql.msaps('');
			self.generatedSql.impala('');
			self.generatedSql.netezza('');

			var expression = ko.toJS(self.model.currentCohortDefinition().expression, pruneJSON);
			var templateSqlPromise = cohortDefinitionAPI.getSql(expression);

			templateSqlPromise.then(function (result) {
				self.templateSql(result.templateSql);
				var mssqlTranslatePromise = translateSql(result.templateSql, 'sql server');
				mssqlTranslatePromise.then(function (result) {
					self.generatedSql.mssql(result.targetSQL);
				});

				var msapsTranslatePromise = translateSql(result.templateSql, 'pdw');
				msapsTranslatePromise.then(function (result) {
					self.generatedSql.msaps(result.targetSQL);
				});

				var oracleTranslatePromise = translateSql(result.templateSql, 'oracle');
				oracleTranslatePromise.then(function (result) {
					self.generatedSql.oracle(result.targetSQL);
				});

				var postgresTranslatePromise = translateSql(result.templateSql, 'postgresql');
				postgresTranslatePromise.then(function (result) {
					self.generatedSql.postgresql(result.targetSQL);
				});

				var redshiftTranslatePromise = translateSql(result.templateSql, 'redshift');
				redshiftTranslatePromise.then(function (result) {
					self.generatedSql.redshift(result.targetSQL);
				});

				var impalaTranslatePromise = translateSql(result.templateSql, 'impala');
				impalaTranslatePromise.then(function (result) {
					self.generatedSql.impala(result.targetSQL);
				});

				var netezzaTranslatePromise = translateSql(result.templateSql, 'netezza');
				netezzaTranslatePromise.then(function(result){
					self.generatedSql.netezza(result.targetSQL);
				});

				$.when(mssqlTranslatePromise, msapsTranslatePromise, oracleTranslatePromise, postgresTranslatePromise, redshiftTranslatePromise, impalaTranslatePromise, netezzaTranslatePromise).then(function () {
					self.isLoadingSql(false);
				});
			});
		}

		self.getSourceInfo = function (sourceKey) {
			return self.model.cohortDefinitionSourceInfo().filter(function (d) {
				return d.sourceKey == sourceKey
			})[0];
		}

		self.getSourceId = function (sourceKey) {
			return sharedState.sources().find(source => source.sourceKey === sourceKey).sourceId;
		}

		self.generateCohort = function (source, includeFeatures) {
			self.stopping[source.sourceKey](false);
			var route = `${config.api.url}cohortdefinition/${self.model.currentCohortDefinition().id()}/generate/${source.sourceKey}`;

			if (includeFeatures) {
				route = `${route}?includeFeatures`;
			}

			self.getSourceInfo(source.sourceKey).status('PENDING');
			if (self.selectedSource() && self.selectedSource().sourceId === source.sourceId) {
				self.loadingReport(true);
			}
			var job = new jobDetail({
				name: self.model.currentCohortDefinition().name() + "_" + source.sourceKey,
				type: 'cohort-generation',
				status: 'PENDING',
				executionId: String(self.model.currentCohortDefinition().id()) + String(self.getSourceId(source.sourceKey)),
				statusUrl: self.config.api.url + 'cohortdefinition/' + self.model.currentCohortDefinition().id() + '/info',
				statusValue: 'status',
				viewed: false,
				url: 'cohortdefinition/' + self.model.currentCohortDefinition().id() + '/generation',
			});

			$.ajax(route, {
				error: authApi.handleAccessDenied,
				success: function (data) {
					job.status(data.status);
					sharedState.jobListing.queue(job);
					setTimeout(function () {
						self.pollForInfo();
					}, 3000);
				}
			});
		}

		self.cancelGenerate = function(source) {
      self.stopping[source.sourceKey](true);
      cohortDefinitionAPI.cancelGenerate(self.model.currentCohortDefinition().id(), source.sourceKey);
		};

		self.hasCDM = function (source) {
			for (var d = 0; d < source.daimons.length; d++) {
				if (source.daimons[d].daimonType == 'CDM') {
					return true;
				}
			}
			return false;
		}

		self.hasResults = function (source) {
			for (var d = 0; d < source.daimons.length; d++) {
				if (source.daimons[d].daimonType == 'Results') {
					return true;
				}
			}
			return false;
		}

    self.canCreateConceptSet = ko.computed(function () {
      return ((authApi.isAuthenticated() && authApi.isPermittedCreateConceptset()) || !config.userAuthenticationEnabled);
    });

    self.closeConceptSet = function () {
			self.model.clearConceptSet();
		}

		self.deleteConceptSet = function () {
			self.model.currentCohortDefinition().expression().ConceptSets.remove(
				function (item) {
					return item.id == self.model.currentConceptSet().id;
				}
			);
			self.closeConceptSet();
		}

		self.showSaveConceptSet = function() {
		  self.newConceptSetName(self.model.currentConceptSet().name());
		  self.saveConceptSetShow(true);
		};

		self.saveConceptSet = function () {
      self.saveConceptSetShow(false);
      var conceptSet = {
        id: 0,
        name: self.newConceptSetName(),
      };
      var conceptSetItems = conceptSetUitls.toConceptSetItems(self.selectedConcepts());
      var conceptSetId;
      var itemsPromise = function(data) {
        conceptSetId = data.id;
        return conceptSetApi.saveConceptSetItems(data.id, conceptSetItems);
      };
      conceptSetApi.saveConceptSet(conceptSet)
        .then(itemsPromise)
    };

		function createConceptSet() {
      var newConceptSet = new ConceptSet();
      var cohortConceptSets = self.model.currentCohortDefinition().expression().ConceptSets;
      newConceptSet.id = cohortConceptSets().reduce(function(max, val){ return Math.max(max, val.id) + 1; }, 0);
			return newConceptSet;
		}

		function loadConceptSet(conceptSet, view) {
      var cohortConceptSets = self.model.currentCohortDefinition().expression().ConceptSets;
      cohortConceptSets.push(conceptSet);
      self.model.loadConceptSet(conceptSet.id, 'cohort-definition-manager', 'cohort', view || 'details');
      self.model.currentCohortDefinitionMode("conceptsets");
    }

		self.newConceptSet = function () {
			loadConceptSet(createConceptSet());
		};

		self.importConceptSet = function () {
		  loadConceptSet(createConceptSet(), 'import');
		  self.conceptSetTabMode(self.cohortConst.conceptSetTabModes.import);
    };

		self.importFromRepository = function() {
			self.showImportConceptSetModal(true);
		};

		self.onConceptSetRepositoryImport = function(newConceptSet, event){
			event.stopPropagation();
			self.showImportConceptSetModal(false);
			vocabularyApi.getConceptSetExpression(newConceptSet.id)
				.done(function(result){
					var conceptSet = self.findConceptSet();
					conceptSet.name(newConceptSet.name);
					conceptSet.expression.items().forEach(function(item){
						sharedState.selectedConceptsIndex[item.concept.CONCEPT_ID] = 0;
						sharedState.selectedConcepts.remove(function(v){
							return v.concept.CONCEPT_ID === item.concept.CONCEPT_ID;
						});
					});
					conceptSet.expression.items().length = 0;
					self.importConceptSetExpressionItems(result.items);
				});
		};

		self.clearImportConceptSetJson = function(){
			self.importConceptSetJson('');
		};

		self.findConceptSet = function(){
      return self.model.currentCohortDefinition()
        .expression()
        .ConceptSets()
        .find(function (item) {
          return item.id === self.model.currentConceptSet().id;
        });
		};

		self.importConceptSetExpression = function() {
      var items = JSON.parse(self.importConceptSetJson()).items;
      self.importConceptSetExpressionItems(items);
    };

    self.importConceptSetExpressionItems = function(items) {
			var conceptSet = self.findConceptSet();
			if (!conceptSet){
				return;
			}

			items.forEach(function(item){
				var conceptSetItem = {};
				conceptSetItem.concept = item.concept;
				conceptSetItem.isExcluded = ko.observable(item.isExcluded);
				conceptSetItem.includeDescendants = ko.observable(item.includeDescendants);
				conceptSetItem.includeMapped = ko.observable(item.includeMapped);

				sharedState.selectedConceptsIndex[item.concept.CONCEPT_ID] = 1;
				sharedState.selectedConcepts.push(conceptSetItem);
			});
			conceptSet.expression.items.valueHasMutated();
			self.clearImportConceptSetJson();
			self.conceptSetTabMode(cohortConst.conceptSetTabModes.details);
		};

    function appendConcepts(data){
      data.forEach(function(item){
        sharedState.selectedConceptsIndex[item.CONCEPT_ID] = 1;
        sharedState.selectedConcepts.push(self.model.createConceptSetItem(item));
      });
      if (self.model.currentCohortDefinition() && self.model.currentConceptSetSource() === "cohort") {
        var conceptSet = self.model.currentCohortDefinition()
          .expression()
          .ConceptSets()
          .find(function (item) {
            return item.id === self.model.currentConceptSet().id;
          });
        if (conceptSet) {
          conceptSet.expression.items.valueHasMutated();
        }
      }
      self.conceptSetTabMode('details');
    }

		self.importConceptIdentifiers = function() {
      self.conceptLoading(true);
			vocabularyApi
        .getConceptsById(self.identifiers().match(/[0-9]+/g))
        .then(appendConcepts, function () { self.conceptLoading(false); })
        .then(function(){ self.conceptLoading(false); })
				.then(function(){ self.identifiers(''); });
		};

		self.importSourceCodes = function () {
      self.conceptLoading(true);
      vocabularyApi
        .getConceptsByCode(self.sourcecodes().match(/[0-9a-zA-Z\.-]+/g))
        .then(appendConcepts, function () {
          self.conceptLoading(false);
        })
        .then(function () {
          self.conceptLoading(false);
        })
        .then(function () {
          self.sourcecodes('');
        });
    }

		self.viewReport = function (sourceKey, reportName) {
			// TODO: Should we prevent running an analysis on an unsaved cohort definition?
			if (self.model.currentCohortDefinition().id() > 0) {
				self.model.reportCohortDefinitionId(self.model.currentCohortDefinition().id());
				self.model.reportReportName(reportName);
				self.model.reportSourceKey(sourceKey);
				self.model.reportTriggerRun(true);
			}
		}

		self.reload = function () {
			if (self.modifiedJSON.length > 0) {
				var updatedExpression = JSON.parse(self.modifiedJSON);
				self.model.currentCohortDefinition().expression(new CohortExpression(updatedExpression));
			}
		}

		self.exportConceptSetsCSV = function () {
			window.open(config.api.url + 'cohortdefinition/' + self.model.currentCohortDefinition().id() + '/export/conceptset');
		}

		self.selectViewReport = function (item) {
			self.selectedSource(item);
			self.loadingReport(true);
			self.selectedReportCaption(item.name);

			cohortDefinitionAPI.getReport(self.model.currentCohortDefinition().id(), item.sourceKey).then(function (report) {
				report.sourceKey = item.sourceKey;
				self.selectedReport(report);
				self.loadingReport(false);
			});
		}

		self.getStatusMessage = function (info) {
			if (info.status() == "COMPLETE" && !info.isValid())
				return "FAILED";
			else
				return info.status();
		}

		self.cohortDefinitionLink = ko.computed(() => {
			if (self.model.currentCohortDefinition()) {
				return self.config.api.url + "/cohortdefinition/" + self.model.currentCohortDefinition().id();
			}
		});

		// reporting sub-system
		self.generateButtonCaption = ko.observable('Generate Reports');
		self.generateReportsEnabled = ko.observable(false);
		self.createReportJobFailed = ko.observable(false);
		self.createReportJobError = ko.observable();
		self.reportingError = ko.observable();
		self.currentJob = ko.observable();
		self.reportingSourceStatusAvailable = ko.observable(false);
		self.reportingSourceStatusLoading = ko.observable(false);
		self.reportOptionCaption = ko.pureComputed(function() {
			 return self.reportingSourceStatusLoading() ? "Loading Reports..." : "Select a Report";
		});
		self.reportingSourceStatus = ko.observable();
		self.reportingAvailableReports = ko.observableArray();

		self.calculateProgress = function (j) {
		  return j.progress() + '%';
		}

		self.model.reportSourceKey.subscribe(s => {
			self.reportingSourceStatusAvailable(false);
			self.reportingAvailableReports.removeAll();
		});

		self.isActiveJob = function (j) {
			var testName = "HERACLES_COHORT_" + self.model.currentCohortDefinition().id() + "_" + self.model.reportSourceKey();
			return j.name == testName && j.status() != 'FAILED' && j.status() != 'COMPLETED';
		}

		self.reportingState = ko.computed(function () {
			// require a data source selection
			if (self.model.reportSourceKey() == undefined) {
				self.generateReportsEnabled(false);
				return "awaiting_selection";
			}

			// check if the cohort has been generated
			var sourceInfo = self.model.cohortDefinitionSourceInfo().find(d => d.sourceKey == self.model.reportSourceKey());
			if (self.getStatusMessage(sourceInfo) != 'COMPLETE') {
				self.generateReportsEnabled(false);
				return "cohort_not_generated";
			}

			// check which reports have required data
			if (!self.reportingSourceStatusAvailable() && !self.reportingSourceStatusLoading()) {
				self.reportingSourceStatusLoading(true);
				cohortReportingAPI.getCompletedAnalyses(sourceInfo, self.model.currentCohortDefinition().id()).done(results => {
					var reports = cohortReportingAPI.getAvailableReports(results);
					if (reports.length == 0) {
						self.reportingAvailableReports(reports);
						self.generateReportsEnabled(false);
						self.reportingSourceStatusAvailable(true);
						self.reportingSourceStatusLoading(false);
						return "checking_status";
					}
					cohortReportingAPI.getCompletedHeraclesHeelAnalyses(sourceInfo, self.model.currentCohortDefinition().id()).done(heelResults => {
						if (heelResults.length > 0) {
							reports.push({name: "Heracles Heel", reportKey: "Heracles Heel", analyses: []});
						}
						self.reportingAvailableReports(reports);
						self.generateReportsEnabled(false);
						self.reportingSourceStatusAvailable(true);
						self.reportingSourceStatusLoading(false);
						return "checking_status";
					});
				});
			}

			// check if we can tell if the job to generate the reports is already running
			if (self.model.currentCohortDefinition()) {
				var listing = sharedState.jobListing;
				var tempJob = listing().find(self.isActiveJob)
				if (tempJob) {
					if (tempJob.status() == 'STARTED' || tempJob.status() == 'STARTING') {
						self.currentJob(tempJob);
						self.generateReportsEnabled(false);
						return "generating_reports";
					}
				}
			}

			if (self.reportingAvailableReports().length == 0) {
				// reset button to allow generation
				self.generateReportsEnabled(true);
				return "report_unavailable";
			}

			if (self.model.reportReportName() == undefined) {
				// reset button to allow regeneration
				self.generateReportsEnabled(true);
				return "awaiting_selection";
			}

			if (self.model.currentCohortDefinition()) {
				self.generateReportsEnabled(true);
				self.model.reportCohortDefinitionId(self.model.currentCohortDefinition().id());
				self.model.reportTriggerRun(true);
				return "report_active";
			}

			var errorPackage = {};
			errorPackage.sourceAnalysesStatus = self.model.sourceAnalysesStatus[self.model.reportSourceKey()]();
			errorPackage.report = self.model.reportReportName();
			self.reportingError(JSON.stringify(errorPackage));
			// reset button to allow regeneration
			self.generateReportsEnabled(false);
			return "unknown_cohort_report_state";
		});

		self.showReportNameDropdown = ko.computed(function () {
			return self.model.reportSourceKey() != undefined &&
				self.reportingState() != 'checking_status' &&
				self.reportingState() != 'cohort_not_generated' &&
				self.reportingState() != 'reports_not_generated' &&
				self.reportingState() != 'generating_reports';
		});

		self.generateAnalyses = function ({ descr, duration, analysisIdentifiers, runHeraclesHeel }) {
			if (!confirm(`This will run ${descr} and may take about ${duration}. Are you sure?`)) {
				return;
			}

			self.generateReportsEnabled(false);
			analysisIdentifiers = _.uniq(analysisIdentifiers);
			var cohortDefinitionId = pageModel.currentCohortDefinition().id();
			var cohortJob = {};

			cohortJob.jobName = 'HERACLES_COHORT_' + cohortDefinitionId + '_' + self.model.reportSourceKey();
			cohortJob.sourceKey = self.model.reportSourceKey();
			cohortJob.smallCellCount = 5;
			cohortJob.cohortDefinitionIds = [];
			cohortJob.cohortDefinitionIds.push(cohortDefinitionId);
			cohortJob.analysisIds = analysisIdentifiers;
			cohortJob.runHeraclesHeel = runHeraclesHeel;
			cohortJob.cohortPeriodOnly = false;

			// set concepts
			cohortJob.conditionConceptIds = [];
			cohortJob.drugConceptIds = [];
			cohortJob.procedureConceptIds = [];
			cohortJob.observationConceptIds = [];
			cohortJob.measurementConceptIds = [];

			var jobDetails = new jobDetail({
				name: cohortJob.jobName,
				status: 'LOADING',
				executionId: null,
				statusUrl: self.config.api.url + 'job/execution/',
				statusValue: 'status',
				progress: 0,
				progressUrl: self.config.api.url + 'cohortresults/' + self.model.reportSourceKey() + '/' + cohortDefinitionId + '/info',
				progressValue: 'progress',
				progressMax: 100,
				viewed: false,
				url: 'cohortdefinition/' + cohortDefinitionId + '/reporting?sourceKey=' + self.model.reportSourceKey(),
			});

			self.createReportJobFailed(false);

			$.ajax({
				url: config.api.url + 'cohortanalysis',
				data: JSON.stringify(cohortJob),
				method: 'POST',
				context: jobDetails,
				contentType: 'application/json',
				success: function (info) {
					this.executionId = info.executionId;
					this.status(info.status);
					this.statusUrl = this.statusUrl + info.executionId;
					sharedState.jobListing.queue(this);
				},
				error: function (xhr, status, error) {
					self.createReportJobFailed(true);
					var createReportJobErrorPackage = {};
					createReportJobErrorPackage.status = status;
					createReportJobErrorPackage.error = xhr.responseText;
					self.createReportJobError(JSON.stringify(createReportJobErrorPackage));

					// reset button to allow generation attempt
					self.generateReportsEnabled(true);
					self.generateButtonCaption('Generate');
				}
			});
		};

    self.generateQuickAnalysis = function () {
      self.generateAnalyses({
        descr: 'minimal analyses set to provide a quick overview of the cohort',
        duration: '10 minutes',
				analysisIdentifiers: cohortReportingAPI.getQuickAnalysisIdentifiers(),
				runHeraclesHeel: false
      });
    };

    self.showUtilizationToRunModal = ko.observable(false);
    self.checkedUtilReports = ko.observableArray([]);

    const reportPacks = cohortReportingAPI.visualizationPacks;
    self.utilReportOptions = [
    	reportPacks.healthcareUtilPersonAndExposureBaseline,
		reportPacks.healthcareUtilPersonAndExposureCohort,
		reportPacks.healthcareUtilVisitRecordsBaseline,
		reportPacks.healthcareUtilVisitDatesBaseline,
		reportPacks.healthcareUtilCareSiteDatesBaseline,
		reportPacks.healthcareUtilVisitRecordsCohort,
		reportPacks.healthcareUtilVisitDatesCohort,
		reportPacks.healthcareUtilCareSiteDatesCohort,
		reportPacks.healthcareUtilDrugBaseline,
		reportPacks.healthcareUtilDrugCohort,
	].map(item => ({
		label: item.name,
		value: item.analyses,
	}));

    self.selectHealthcareAnalyses = function() {
        self.showUtilizationToRunModal(true);
	}

    self.generateHealthcareAnalyses = function () {
		const analysisIds = self.checkedUtilReports().reduce((acc, ids) => [...acc, ...ids], []);

		self.generateAnalyses({
		  descr: 'the Cost and Utilization analyses',
		  duration: '10-45 minutes',
		  analysisIdentifiers: analysisIds,
		  runHeraclesHeel: false
		});

        self.showUtilizationToRunModal(false);
    };

    self.generateAllAnalyses = function () {
      self.generateAnalyses({
        descr: 'all analyses',
        duration: '60-90 minutes',
				analysisIdentifiers: cohortReportingAPI.getAnalysisIdentifiers(),
				runHeraclesHeel: true
      });
    };

		// dispose subscriptions / cleanup computed observables (non-pureComputeds)
		self.dispose = function () {
			self.cohortDefinitionLink.dispose();
			self.cohortDefinitionCaption.dispose();
			self.tabPath.dispose();
			self.sortedConceptSets.dispose();
			self.reportingState.dispose();
			self.showReportNameDropdown.dispose();
			
		}
		self.getCriteriaIndexComponent = function (data) {
			data = ko.utils.unwrapObservable(data);
			if (!data) return;
			if (data.hasOwnProperty("ConditionOccurrence"))
				return "condition-occurrence-criteria-viewer";
			else if (data.hasOwnProperty("ConditionEra"))
				return "condition-era-criteria-viewer";
			else if (data.hasOwnProperty("DrugExposure"))
				return "drug-exposure-criteria-viewer";
			else if (data.hasOwnProperty("DrugEra"))
				return "drug-era-criteria-viewer";
			else if (data.hasOwnProperty("DoseEra"))
				return "dose-era-criteria-viewer";
			else if (data.hasOwnProperty("ProcedureOccurrence"))
				return "procedure-occurrence-criteria-viewer";
			else if (data.hasOwnProperty("Observation"))
				return "observation-criteria-viewer";
			else if (data.hasOwnProperty("VisitOccurrence"))
				return "visit-occurrence-criteria-viewer";
			else if (data.hasOwnProperty("DeviceExposure"))
				return "device-exposure-criteria-viewer";
			else if (data.hasOwnProperty("Measurement"))
				return "measurement-criteria-viewer";
			else if (data.hasOwnProperty("Specimen"))
				return "specimen-criteria-viewer";
			else if (data.hasOwnProperty("ObservationPeriod"))
				return "observation-period-criteria-viewer";
			else if (data.hasOwnProperty("PayerPlanPeriod"))
				return "payer-plan-period-criteria-viewer";
			else if (data.hasOwnProperty("Death"))
				return "death-criteria-viewer";
			else
				return "unknownCriteriaType";
		};
		self.selectedCriteria = ko.observable();

		self.copyToClipboard = function (clipboardButtonId, clipboardButtonMessageId) {
			var currentClipboard = new clipboard(clipboardButtonId);

			currentClipboard.on('success', function (e) {
				console.log('Copied to clipboard');
				e.clearSelection();
				$(clipboardButtonMessageId).fadeIn();
				setTimeout(function () {
					$(clipboardButtonMessageId).fadeOut();
				}, 1500);
			});

			currentClipboard.on('error', function (e) {
				console.log('Error copying to clipboard');
				console.log(e);
			});
		}

		self.copyExpressionToClipboard = function () {
			self.copyToClipboard('#btnCopyExpressionClipboard', '#copyExpressionToClipboardMessage');
		}

		self.copyIdentifierListToClipboard = function () {
			self.copyToClipboard('#btnCopyIdentifierListClipboard', '#copyIdentifierListMessage');
		}

		self.copyIncludedConceptIdentifierListToClipboard = function () {
			self.copyToClipboard('#btnCopyIncludedConceptIdentifierListClipboard', '#copyIncludedConceptIdentifierListMessage');
		}

		self.copyTextViewToClipboard = function () {
			self.copyToClipboard('#btnCopyTextViewClipboard', '#copyTextViewMessage');
		}

		self.copyCohortExpressionJSONToClipboard = function () {
			self.copyToClipboard('#btnCopyExpressionJSONClipboard', '#copyCohortExpressionJSONMessage');
		}

		self.copyCohortSQLToClipboard = function () {
			self.copyToClipboard('#btnCopyCohortSQLClipboard', '#copyCopyCohortSQLMessage');
		}
	}

	var component = {
		viewModel: cohortDefinitionManager,
		template: view
	};

	ko.components.register('cohort-definition-manager', component);
	return component;
});
